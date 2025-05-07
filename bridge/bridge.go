package bridge

import (
	"embed"
	"log"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"slices"
	"strings"

	sysruntime "runtime"

	"github.com/klauspost/cpuid/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"gopkg.in/yaml.v3"
)

var Config = &AppConfig{}

var Env = &EnvResult{
	IsStartup:   true,
	FromTaskSch: false,
	AppName:     "",
	BasePath:    "",
	OS:          sysruntime.GOOS,
	ARCH:        sysruntime.GOARCH,
	X64Level:    cpuid.CPU.X64Level(),
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		AppMenu: menu.NewMenu(),
	}
}

func CreateApp(fs embed.FS) *App {
	exePath, err := os.Executable()
	if err != nil {
		panic(err)
	}

	Env.BasePath = filepath.Dir(exePath)
	Env.AppName = filepath.Base(exePath)

	if slices.Contains(os.Args, "tasksch") {
		Env.FromTaskSch = true
	}

	app := NewApp()

	if Env.OS == "darwin" {
		createMacOSSymlink()
		createMacOSMenus(app)
	}

	extractEmbeddedFiles(fs)

	loadConfig()

	return app
}

func (a *App) IsStartup() bool {
	if Env.IsStartup {
		Env.IsStartup = false
		return true
	}
	return false
}

func (a *App) RestartApp() FlagResult {
	exePath := Env.BasePath + "/" + Env.AppName

	cmd := exec.Command(exePath)
	SetCmdWindowHidden(cmd)

	if err := cmd.Start(); err != nil {
		return FlagResult{false, err.Error()}
	}

	a.ExitApp()

	return FlagResult{true, "Success"}
}

func (a *App) GetEnv() EnvResult {
	return EnvResult{
		AppName:  Env.AppName,
		BasePath: Env.BasePath,
		OS:       Env.OS,
		ARCH:     Env.ARCH,
		X64Level: Env.X64Level,
	}
}

func (a *App) GetInterfaces() FlagResult {
	log.Printf("GetInterfaces")

	interfaces, err := net.Interfaces()
	if err != nil {
		return FlagResult{false, err.Error()}
	}

	var interfaceNames []string

	for _, inter := range interfaces {
		interfaceNames = append(interfaceNames, inter.Name)
	}

	return FlagResult{true, strings.Join(interfaceNames, "|")}
}

func (a *App) ShowMainWindow() {
	runtime.WindowShow(a.Ctx)
}

func createMacOSSymlink() {
	user, _ := user.Current()
	linkPath := Env.BasePath + "/data"
	appPath := "/Users/" + user.Username + "/Library/Application Support/" + Env.AppName
	os.MkdirAll(appPath, os.ModePerm)
	os.Symlink(appPath, linkPath)
}

func createMacOSMenus(app *App) {
	appMenu := app.AppMenu.AddSubmenu("App")
	appMenu.AddText("Show", keys.CmdOrCtrl("s"), func(_ *menu.CallbackData) {
		runtime.WindowShow(app.Ctx)
	})
	appMenu.AddText("Hide", keys.CmdOrCtrl("h"), func(_ *menu.CallbackData) {
		runtime.WindowHide(app.Ctx)
	})
	appMenu.AddSeparator()
	appMenu.AddText("Quit", keys.CmdOrCtrl("q"), func(_ *menu.CallbackData) {
		runtime.EventsEmit(app.Ctx, "exitApp")
	})

	// on macos platform, we should append EditMenu to enable Cmd+C,Cmd+V,Cmd+Z... shortcut
	app.AppMenu.Append(menu.EditMenu())
}

func extractEmbeddedFiles(fs embed.FS) {
	iconSrc := "frontend/dist/icons"
	iconDst := "data/.cache/icons"
	imgSrc := "frontend/dist/imgs"
	imgDst := "data/.cache/imgs"

	os.MkdirAll(GetPath(iconDst), os.ModePerm)
	os.MkdirAll(GetPath(imgDst), os.ModePerm)

	extractFiles(fs, iconSrc, iconDst)
	extractFiles(fs, imgSrc, imgDst)
}

func extractFiles(fs embed.FS, srcDir, dstDir string) {
	files, _ := fs.ReadDir(srcDir)
	for _, file := range files {
		fileName := file.Name()
		dstPath := GetPath(dstDir + "/" + fileName)
		if _, err := os.Stat(dstPath); os.IsNotExist(err) {
			log.Printf("InitResources [%s]: %s", dstDir, fileName)
			data, _ := fs.ReadFile(srcDir + "/" + fileName)
			if err := os.WriteFile(dstPath, data, os.ModePerm); err != nil {
				log.Printf("Error writing file %s: %v", dstPath, err)
			}
		}
	}
}

func loadConfig() {
	b, err := os.ReadFile(Env.BasePath + "/data/user.yaml")
	if err == nil {
		yaml.Unmarshal(b, &Config)
	}

	if Config.Width == 0 {
		Config.Width = 800
	}

	if Config.Height == 0 {
		if Env.OS == "linux" {
			Config.Height = 510
		} else {
			Config.Height = 540
		}
	}

	Config.StartHidden = Env.FromTaskSch && Config.WindowStartState == int(options.Minimised)

	if !Env.FromTaskSch {
		Config.WindowStartState = int(options.Normal)
	}
}
