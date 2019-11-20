"use strict";
const {
  app,
  nativeImage,
  shell,
  Menu,
  session,
  Tray,
  BrowserWindow,
  ipcMain,
  ipcRenderer
} = require("electron");
const { autoUpdater } = require("electron-updater");
const autoLaunch = require("auto-launch");
const storage = require("electron-json-storage");
const fs = require("fs");
const request = require("request-promise");

const settings = require("./app/settings");

const iconPath = __dirname + "/src/resources/images/icon.ico";

const devMode = process.argv[1] === ".";
const isPortable = process.env.PORTABLE_EXECUTABLE_DIR !== undefined;
const gotTheLock = app.requestSingleInstanceLock();

let appLoaded = false;

let authWindow = null;
let mainWindow = null;
let Browser = null;
let _session = null;
let Lang = null;
let tray = null;
let user = null;
let execPath = process.execPath.match(/.*\\/i)[0];

if (isPortable) execPath = process.env.PORTABLE_EXECUTABLE_DIR + "\\";

app.disableHardwareAcceleration();

storage.setDataPath(execPath + "data");

let autostart = new autoLaunch({ name: "GiftSeeker" });

// Если произошёл повторный запуск процесса то переводим фокус на окно программы
app.on("second-instance", (commandLine, workingDirectory) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();

    if (!mainWindow.isVisible()) mainWindow.show();

    mainWindow.focus();
  }
});

if (!gotTheLock) return app.quit();

ipcMain.on("save-user", function(event, data) {
  user = data;
  global.user = data;
});

ipcMain.on("change-lang", function(event, data) {
  Lang.change(data);
  event.sender.send("change-lang", data);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

settings.on("change", (configKey, newValue) => {
  if (configKey === "start_with_os") autoStartControl(newValue);
});

app.on("ready", () => {
  Lang = new LanguageClass();
  _session = session.fromPartition("persist:GiftSeeker");
  _session.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/64.0.3282.186 Safari/537.36"
  );

  authWindow = new BrowserWindow({
    width: 280,
    height: 340,
    title: "GiftSeeker",
    icon: iconPath,
    show: false,
    center: true,
    resizable: false,
    frame: false,
    webPreferences: {
      session: _session,
      devTools: devMode,
      nodeIntegration: true
    }
  });

  authWindow.setMenu(null);

  mainWindow = new BrowserWindow({
    width: 730,
    height: 500,
    title: "GiftSeeker",
    icon: iconPath,
    show: false,
    center: true,
    resizable: false,
    frame: false,
    webPreferences: {
      session: _session,
      devTools: devMode,
      nodeIntegration: true
    }
  });

  mainWindow.setMenu(null);

  if (devMode) {
    authWindow.webContents.openDevTools({ mode: "detach" });
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  //### Browser for websites

  Browser = new BrowserWindow({
    parent: mainWindow,
    icon: iconPath,
    title: "GS Browser",
    width: 1024,
    height: 600,
    minWidth: 600,
    minHeight: 500,
    modal: true,
    show: false,
    center: true,
    webPreferences: {
      nodeIntegration: false,
      session: _session,
      devTools: false
    }
  });

  Browser.loadFile("./src/web/blank.html");

  Browser.setMenu(null);

  Browser.on("close", e => {
    e.preventDefault();
    Browser.loadFile("./src/web/blank.html");
    Browser.hide();

    if (mainWindow.hidden) authWindow.focus();
    else mainWindow.focus();
  });

  //### end browser for websites

  authWindow.on("show", () => {
    authWindow.webContents.executeJavaScript("onShow()");
  });

  authWindow.on("close", () => {
    authWindow.removeAllListeners("close");
    mainWindow.close();
  });

  mainWindow.on("close", () => {
    mainWindow.removeAllListeners("close");
    authWindow.close();
  });

  authWindow.on("closed", () => {
    authWindow = null;
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Работа с треем
  tray = new Tray(nativeImage.createFromPath(iconPath));
  const trayMenu = Menu.buildFromTemplate([
    {
      label: "Open Website",
      click: () => {
        Browser.loadURL("https://giftseeker.ru/");
        Browser.show();
      }
    },
    { type: "separator" },
    { role: "quit" }
  ]);

  tray.setToolTip("GiftSeeker " + app.getVersion());
  tray.setContextMenu(trayMenu);
  tray.on("click", () => {
    if (user === null)
      authWindow.isVisible() ? authWindow.hide() : authWindow.show();
    else mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });

  // Ссылки в глобальное пространство
  global.sharedData = {
    isPortable: isPortable,
    autoUpdater: autoUpdater,
    devMode: devMode,
    shell: shell,
    TrayIcon: tray,
    ipcMain: ipcMain,
    Lang: Lang,
    Config: settings,
    Browser: Browser,
    authWindow: authWindow,
    mainWindow: mainWindow,
    Request: request
  };
});

function startApp() {
  if (appLoaded) return;

  Lang.loadLangs(() => {
    authWindow.loadFile("./src/web/auth.html");

    authWindow.on("ready-to-show", function() {
      authWindow.show();

      if (settings.get("start_minimized")) authWindow.hide();
      else authWindow.focus();
    });
  });

  appLoaded = true;
}

function autoStartControl(startWithOs) {
  if (startWithOs === true && !devMode) {
    autostart.enable().catch(() => {});
    return;
  }

  autostart.disable().catch(() => {});
}

function log(logThis) {
  if (devMode) console.log(logThis);
}

class LanguageClass {
  constructor() {
    this.default = "ru_RU";
    this.languages = {};
    this.langsCount = 0;

    // Проверяем наличие локализаций в директории с данными, если чего-то не хватает то скачиваем
    request({ uri: "https://giftseeker.ru/api/langs_new", json: true })
      .then(data => {
        if (!data.response) {
          startApp();
          return;
        }
        const languages = JSON.parse(data.response).langs;

        let languagesLoaded = 0;

        languages.forEach(language => {
          const { name, size } = language;

          let loadLang = () => {
            request({ uri: "https://giftseeker.ru/trans/" + name })
              .then(lang => {
                fs.writeFile(
                  storage.getDataPath() + "/" + name,
                  lang,
                  err => {}
                );
              })
              .finally(() => {
                languagesLoaded++;

                // запускаем приложение когда загружены все языки
                if (languagesLoaded >= languages.length) startApp();
              })
              .catch(err => console.log("lang loading error ", err));
          };

          if (!fs.existsSync(storage.getDataPath() + "/" + name)) loadLang();
          else {
            fs.stat(storage.getDataPath() + "/" + name, (err, stats) => {
              if (stats.size !== size) loadLang();
              else languagesLoaded++;

              // запускаем приложение если загружены все языки
              if (languagesLoaded === languages.length) startApp();
            });
          }
        });
      })
      .catch(() => {
        startApp();
        console.log("catchLang Constructor");
      });
  }

  loadLangs(callback) {
    let _this = this;

    if (fs.existsSync(storage.getDataPath())) {
      let lng_to_load = [];
      let dir = fs.readdirSync(storage.getDataPath());

      for (let x = 0; x < dir.length; x++) {
        if (dir[x].indexOf("lang.") >= 0) {
          lng_to_load.push(dir[x].replace(".json", ""));
        }
      }

      if (!lng_to_load.length) return;

      storage.getMany(lng_to_load, function(error, langs) {
        if (error) throw new Error(`Can't load selected translation`);

        let lng;

        for (lng in langs.lang) _this.langsCount++;

        if (langs.lang[settings.get("lang", _this.default)] === undefined) {
          _this.default = lng;
          settings.set("lang", _this.default);
        }

        _this.languages = langs.lang;

        if (callback) callback();
      });
    }
  }

  get(key) {
    let response = this.languages;
    let splited = (settings.get("lang", this.default) + "." + key).split(".");

    for (let i = 0; i < splited.length; i++) {
      if (response[splited[i]] !== undefined) {
        response = response[splited[i]];
      } else {
        response = key;
        break;
      }
    }

    return response;
  }

  change(setLang) {
    settings.set("lang", setLang);
  }

  count() {
    return this.langsCount;
  }

  current() {
    return settings.get("lang", this.default);
  }

  list() {
    return this.languages;
  }
}