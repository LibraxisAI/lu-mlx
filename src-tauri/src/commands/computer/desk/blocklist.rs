//! The apps and system surfaces computer use never touches.
//!
//! This list is data and it is not a setting: nothing in the interface, no
//! approval and no autonomy switch reaches past it. A window is judged by the
//! process behind it (executable name, bundle id), by its window class where
//! the process alone does not say enough (a console hosts any program), and
//! by what the platform reports about its rights.

use super::keys::{Chord, KeyName, Modifier};
use super::types::WindowInfo;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockReason {
    /// LU itself: the model must not drive its own approvals.
    OwnApp,
    Terminal,
    PasswordManager,
    /// Sign-in, credential and permission dialogs of the system.
    SystemDialog,
    /// Settings that control security, accounts and permissions.
    SecuritySettings,
    /// The Run dialog and the system launchers: whatever is typed into them
    /// runs as a command, without a window the list could judge afterwards.
    Launcher,
    /// A window with more rights than LU, or a secure desktop.
    Elevated,
    /// No window is in front, which is also how a secure desktop looks.
    NoForeground,
}

impl BlockReason {
    pub fn sentence(self) -> &'static str {
        match self {
            BlockReason::OwnApp => "LU does not control its own window.",
            BlockReason::Terminal => "Terminals and shells are always off limits for computer control.",
            BlockReason::PasswordManager => "Password managers are always off limits for computer control.",
            BlockReason::SystemDialog => "Sign-in and permission dialogs of the system are always off limits for computer control.",
            BlockReason::SecuritySettings => "System settings for security and accounts are always off limits for computer control.",
            BlockReason::Launcher => "The Run dialog and system launchers run whatever is typed into them, so they are always off limits for computer control.",
            BlockReason::Elevated => "This window runs with administrator rights and is always off limits for computer control.",
            BlockReason::NoForeground => "No app window is in front, or a secure system screen is showing.",
        }
    }
}

/// Each build constructs one of these; the tests judge all three.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum Platform {
    Windows,
    MacOs,
    Linux,
}

pub struct BlockRule {
    pub reason: BlockReason,
    /// Lower case executable file names (Windows with `.exe`) or, on macOS,
    /// lower case bundle ids. A trailing `*` matches a prefix.
    pub apps: &'static [&'static str],
    /// Lower case window classes (Windows) or WM_CLASS values (X11).
    pub classes: &'static [&'static str],
}

const WINDOWS: &[BlockRule] = &[
    BlockRule {
        reason: BlockReason::Terminal,
        apps: &[
            "cmd.exe", "powershell.exe", "pwsh.exe", "powershell_ise.exe", "windowsterminal.exe", "wt.exe",
            "openconsole.exe", "conhost.exe", "wsl.exe", "wslhost.exe", "bash.exe", "sh.exe", "zsh.exe",
            "mintty.exe", "git-bash.exe", "alacritty.exe", "wezterm-gui.exe", "wezterm.exe", "hyper.exe",
            "tabby.exe", "kitty.exe", "putty.exe", "kitty_portable.exe", "conemu.exe", "conemu64.exe",
            "conemuc.exe", "conemuc64.exe", "cmder.exe", "warp.exe", "mobaxterm.exe", "securecrt.exe",
            "termius.exe", "fluentterminal.systemtray.exe", "fluentterminal.app.exe", "nu.exe", "ssh.exe",
            "ubuntu.exe", "debian.exe", "ghostty.exe", "rio.exe",
        ],
        classes: &["consolewindowclass", "cascadia_hosting_window_class", "pseudoconsolewindow", "mintty", "putty", "virtualconsoleclass"],
    },
    BlockRule {
        reason: BlockReason::PasswordManager,
        apps: &[
            "1password.exe", "bitwarden.exe", "keepass.exe", "keepassxc.exe", "lastpass.exe", "dashlane.exe",
            "nordpass.exe", "protonpass.exe", "proton pass.exe", "enpass.exe", "roboform.exe", "keeperpasswordmanager.exe",
            "keeper.exe", "passwordboss.exe", "stickypassword.exe", "keeweb.exe", "authy desktop.exe", "kpxc.exe",
        ],
        classes: &[],
    },
    BlockRule {
        reason: BlockReason::SystemDialog,
        apps: &[
            "consent.exe", "logonui.exe", "lockapp.exe", "credentialuibroker.exe", "credwiz.exe", "winlogon.exe",
            "lsass.exe", "userinit.exe", "securityhealthsystray.exe", "smartscreen.exe", "dwwin.exe",
            "windowsdefendersecuritycenter.exe", "cloudexperiencehost.exe", "pickerhost.exe",
        ],
        classes: &["credential dialog xaml host", "$$$secure uap dummy window class for interim dialog"],
    },
    BlockRule {
        reason: BlockReason::SecuritySettings,
        apps: &[
            "systemsettings.exe", "sechealthui.exe", "securityhealthhost.exe", "useraccountcontrolsettings.exe",
            "mmc.exe", "regedit.exe", "taskmgr.exe", "gpedit.msc", "netplwiz.exe", "certmgr.msc", "msconfig.exe",
            "systempropertiesadvanced.exe", "systempropertiesprotection.exe", "wf.msc", "control.exe",
            "computerdefaults.exe", "optionalfeatures.exe", "perfmon.exe", "eventvwr.exe",
        ],
        classes: &[],
    },
    BlockRule {
        reason: BlockReason::Launcher,
        apps: &[
            "searchapp.exe", "searchhost.exe", "searchui.exe", "cortana.exe", "powertoys.powerlauncher.exe",
            "powertoys.run.exe", "flow.launcher.exe", "wox.exe", "keypirinha-x64.exe", "keypirinha-x86.exe", "launchy.exe",
            "listary.exe", "ueli.exe", "raycast.exe",
        ],
        classes: &[],
    },
];

const MACOS: &[BlockRule] = &[
    BlockRule {
        reason: BlockReason::Terminal,
        apps: &[
            "com.apple.terminal", "com.googlecode.iterm2", "dev.warp.warp-stable", "dev.warp.warp*", "net.kovidgoyal.kitty",
            "org.alacritty", "io.alacritty", "com.github.wez.wezterm", "co.zeit.hyper", "com.mitchellh.ghostty",
            "org.tabby", "com.raphaelamorim.rio", "com.panic.prompt*", "com.termius*", "com.apple.scripteditor2",
            "com.apple.automator",
        ],
        classes: &[],
    },
    BlockRule {
        reason: BlockReason::PasswordManager,
        apps: &[
            "com.apple.passwords", "com.apple.keychainaccess", "com.1password.1password", "com.agilebits.onepassword*",
            "com.bitwarden.desktop", "org.keepassxc.keepassxc", "com.lastpass.lastpass*", "com.dashlane.dashlane*",
            "com.nordpass.macos*", "me.proton.pass*", "in.sinew.enpass*", "com.siber.roboform*", "com.callpod.keepermac*",
            "com.hicknhacksoftware.macpass", "org.keeweb.keeweb", "com.strongbox*", "com.markmcguill.strongbox*",
        ],
        classes: &[],
    },
    BlockRule {
        reason: BlockReason::SystemDialog,
        apps: &[
            "com.apple.securityagent", "com.apple.loginwindow", "com.apple.usernotificationcenter",
            "com.apple.localauthentication.uiagent", "com.apple.accessibility.universalaccessauthwarn",
            "com.apple.authkitui*", "com.apple.coreservices.uiagent", "com.apple.systemadministration.install",
            "com.apple.screensaver.engine", "com.apple.appleid.authentication*", "com.apple.tccd",
        ],
        classes: &[],
    },
    BlockRule {
        reason: BlockReason::SecuritySettings,
        apps: &[
            "com.apple.systempreferences", "com.apple.systemsettings*", "com.apple.directoryutility",
            "com.apple.activitymonitor", "com.apple.diskutility", "com.apple.console",
        ],
        classes: &[],
    },
    BlockRule {
        reason: BlockReason::Launcher,
        apps: &[
            "com.apple.spotlight", "com.raycast.macos", "com.runningwithcrayons.alfred*", "com.alfredapp.alfred*",
            "at.obdev.launchbar*",
        ],
        classes: &[],
    },
];

const LINUX: &[BlockRule] = &[
    BlockRule {
        reason: BlockReason::Terminal,
        apps: &[
            "gnome-terminal-server", "gnome-terminal", "kgx", "ptyxis", "konsole", "yakuake", "xterm",
            "uxterm", "alacritty", "kitty", "wezterm-gui", "wezterm", "foot", "footclient", "tilix", "terminator",
            "xfce4-terminal", "lxterminal", "mate-terminal", "qterminal", "st", "urxvt", "rxvt", "rxvt-unicode", "tilda",
            "guake", "hyper", "tabby", "warp", "warp-terminal", "ghostty", "cool-retro-term", "terminology",
            "deepin-terminal", "sakura", "terminix", "blackbox", "rio", "contour", "bash", "zsh", "fish", "sh",
        ],
        classes: &[
            "gnome-terminal-server", "org.gnome.console", "org.gnome.ptyxis", "konsole", "xterm", "uxterm", "alacritty",
            "kitty", "org.wezfurlong.wezterm", "foot", "tilix", "terminator", "xfce4-terminal", "lxterminal",
            "mate-terminal", "qterminal", "st-256color", "urxvt", "com.mitchellh.ghostty", "guake", "yakuake", "tilda",
        ],
    },
    BlockRule {
        reason: BlockReason::PasswordManager,
        apps: &[
            "keepassxc", "keepass2", "1password", "bitwarden", "enpass", "seahorse", "kwalletmanager5", "kwalletmanager",
            "kwalletd5", "kwalletd6", "gnome-keyring-daemon", "secrets", "buttercup", "proton-pass", "nordpass", "keeweb",
            "qtpass", "lastpass",
        ],
        classes: &["keepassxc", "1password", "bitwarden", "seahorse", "org.gnome.seahorse.application", "org.gnome.world.secrets"],
    },
    BlockRule {
        reason: BlockReason::SystemDialog,
        apps: &[
            "polkit-gnome-authentication-agent-1", "polkit-kde-authentication-agent-1", "polkit-mate-authentication-agent-1",
            "lxpolkit", "lxqt-policykit-agent", "xfce-polkit", "gcr-prompter", "gcr4-ssh-askpass", "pinentry",
            "pinentry-gtk-2", "pinentry-gnome3", "pinentry-qt", "pinentry-qt5", "ssh-askpass", "ksshaskpass", "gksu",
            "gksudo", "kdesu", "kdesudo", "pkexec", "gdm", "gdm-session-worker", "gnome-shell-portal-helper", "lightdm",
            "lightdm-gtk-greeter", "sddm", "sddm-greeter", "i3lock", "xscreensaver", "xsecurelock", "light-locker",
            "gnome-screensaver", "kscreenlocker_greet", "xdg-desktop-portal-gtk", "xdg-desktop-portal-gnome",
            "xdg-desktop-portal-kde",
        ],
        classes: &["gcr-prompter", "pinentry", "polkit-gnome-authentication-agent-1", "ssh-askpass"],
    },
    BlockRule {
        reason: BlockReason::SecuritySettings,
        apps: &[
            "gnome-control-center", "systemsettings", "systemsettings5", "systemsettings6", "xfce4-settings-manager",
            "cinnamon-settings", "mate-control-center", "unity-control-center", "users-admin", "gufw", "firewall-config",
            "software-properties-gtk", "gnome-system-monitor", "ksysguard", "plasma-systemmonitor",
        ],
        classes: &["gnome-control-center", "org.gnome.settings", "systemsettings"],
    },
    BlockRule {
        reason: BlockReason::Launcher,
        apps: &[
            "rofi", "dmenu", "dmenu_run", "wofi", "bemenu", "bemenu-run", "fuzzel", "tofi", "krunner", "ulauncher",
            "albert", "synapse", "xfce4-appfinder", "gmrun", "kupfer", "lxqt-runner", "gnome-do",
        ],
        classes: &["rofi", "dmenu", "krunner", "ulauncher", "albert", "xfce4-appfinder", "gmrun"],
    },
];

pub fn rules(platform: Platform) -> &'static [BlockRule] {
    match platform {
        Platform::Windows => WINDOWS,
        Platform::MacOs => MACOS,
        Platform::Linux => LINUX,
    }
}

/// The chords that open a launcher. They are refused outright instead of
/// asked about: the launcher they open is on the list, so a "yes" would only
/// lead to the next refusal, with a system dialog left open on the way.
pub fn blocked_chord(platform: Platform, chord: &Chord) -> Option<&'static str> {
    let meta = |c: char| chord.is(&[Modifier::Meta], KeyName::Char(c));
    match platform {
        Platform::Windows if meta('r') => Some("This chord opens the Run dialog."),
        Platform::Windows if meta('s') || meta('q') => Some("This chord opens the system search, which runs what is typed into it."),
        Platform::MacOs if chord.is(&[Modifier::Meta], KeyName::Space) => Some("This chord opens Spotlight, which runs what is typed into it."),
        Platform::Linux if chord.is(&[Modifier::Alt], KeyName::F(2)) => Some("This chord opens the run dialog of the desktop."),
        _ => None,
    }
}

fn matches_any(patterns: &[&str], value: &str) -> bool {
    patterns.iter().any(|pattern| match pattern.strip_suffix('*') {
        Some(prefix) => value.starts_with(prefix),
        None => *pattern == value,
    })
}

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// Every name this window's process can be recognised by, lower case.
fn names_of(window: &WindowInfo) -> Vec<String> {
    let mut names = vec![window.app.key.to_lowercase()];
    if let Some(bundle) = &window.app.bundle_id {
        names.push(bundle.to_lowercase());
    }
    if let Some(exe) = &window.app.exe {
        names.push(file_name(exe).to_lowercase());
    }
    names.retain(|n| !n.is_empty());
    names.dedup();
    names
}

/// Is this app key on the list, whatever window it shows? Used to refuse an
/// approval for a blocked app before a window of it is even in front.
pub fn blocked_key(platform: Platform, key: &str) -> Option<BlockReason> {
    let key = key.to_lowercase();
    rules(platform).iter().find(|rule| matches_any(rule.apps, &key)).map(|rule| rule.reason)
}

/// The verdict of the blocklist for one window. `None` means the list has no
/// objection; an approval is still needed.
pub fn blocked(platform: Platform, window: &WindowInfo) -> Option<BlockReason> {
    if window.is_self {
        return Some(BlockReason::OwnApp);
    }
    if window.elevated == Some(true) {
        return Some(BlockReason::Elevated);
    }
    // The Run dialog belongs to the file manager, which is an ordinary app.
    // The platform layer recognises the dialog itself.
    if window.launcher {
        return Some(BlockReason::Launcher);
    }
    let names = names_of(window);
    // A process without any name cannot be judged, and cannot be approved by
    // name either. Treat it like a system surface.
    if names.is_empty() {
        return Some(BlockReason::SystemDialog);
    }
    let class = window.class_name.as_deref().map(str::to_lowercase);
    for rule in rules(platform) {
        if names.iter().any(|name| matches_any(rule.apps, name)) {
            return Some(rule.reason);
        }
        if let Some(class) = &class {
            // An X11 WM_CLASS is "instance\0class"; either half may match.
            if class.split('\0').any(|part| matches_any(rule.classes, part)) {
                return Some(rule.reason);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::AppIdentity;

    fn window(key: &str) -> WindowInfo {
        WindowInfo {
            id: 1,
            pid: 100,
            app: AppIdentity { key: key.into(), name: key.into(), exe: None, bundle_id: None },
            title: "t".into(),
            ..Default::default()
        }
    }

    #[test]
    fn windows_terminals_and_shells_are_blocked() {
        for exe in ["cmd.exe", "powershell.exe", "pwsh.exe", "WindowsTerminal.exe", "wsl.exe", "mintty.exe", "putty.exe"] {
            assert_eq!(blocked(Platform::Windows, &window(exe)), Some(BlockReason::Terminal), "{exe}");
        }
    }

    #[test]
    fn a_console_window_is_blocked_whatever_runs_in_it() {
        let mut python = window("python.exe");
        python.class_name = Some("ConsoleWindowClass".into());
        assert_eq!(blocked(Platform::Windows, &python), Some(BlockReason::Terminal));
        let mut hosted = window("someapp.exe");
        hosted.class_name = Some("CASCADIA_HOSTING_WINDOW_CLASS".into());
        assert_eq!(blocked(Platform::Windows, &hosted), Some(BlockReason::Terminal));
    }

    #[test]
    fn windows_system_surfaces_are_blocked() {
        assert_eq!(blocked(Platform::Windows, &window("consent.exe")), Some(BlockReason::SystemDialog));
        assert_eq!(blocked(Platform::Windows, &window("LogonUI.exe")), Some(BlockReason::SystemDialog));
        assert_eq!(blocked(Platform::Windows, &window("CredentialUIBroker.exe")), Some(BlockReason::SystemDialog));
        assert_eq!(blocked(Platform::Windows, &window("SystemSettings.exe")), Some(BlockReason::SecuritySettings));
        assert_eq!(blocked(Platform::Windows, &window("SecHealthUI.exe")), Some(BlockReason::SecuritySettings));
        assert_eq!(blocked(Platform::Windows, &window("1Password.exe")), Some(BlockReason::PasswordManager));
        assert_eq!(blocked(Platform::Windows, &window("KeePassXC.exe")), Some(BlockReason::PasswordManager));
    }

    #[test]
    fn macos_is_judged_by_bundle_id() {
        let mut terminal = window("com.apple.terminal");
        terminal.app.bundle_id = Some("com.apple.Terminal".into());
        assert_eq!(blocked(Platform::MacOs, &terminal), Some(BlockReason::Terminal));
        for (bundle, reason) in [
            ("com.googlecode.iterm2", BlockReason::Terminal),
            ("dev.warp.Warp-Stable", BlockReason::Terminal),
            ("com.apple.SecurityAgent", BlockReason::SystemDialog),
            ("com.apple.UserNotificationCenter", BlockReason::SystemDialog),
            ("com.apple.loginwindow", BlockReason::SystemDialog),
            ("com.apple.systempreferences", BlockReason::SecuritySettings),
            ("com.apple.Passwords", BlockReason::PasswordManager),
            ("com.agilebits.onepassword7", BlockReason::PasswordManager),
            ("com.1password.1password", BlockReason::PasswordManager),
        ] {
            assert_eq!(blocked(Platform::MacOs, &window(bundle)), Some(reason), "{bundle}");
        }
    }

    #[test]
    fn linux_is_judged_by_process_and_by_wm_class() {
        assert_eq!(blocked(Platform::Linux, &window("gnome-terminal-server")), Some(BlockReason::Terminal));
        assert_eq!(blocked(Platform::Linux, &window("konsole")), Some(BlockReason::Terminal));
        assert_eq!(blocked(Platform::Linux, &window("keepassxc")), Some(BlockReason::PasswordManager));
        assert_eq!(blocked(Platform::Linux, &window("polkit-gnome-authentication-agent-1")), Some(BlockReason::SystemDialog));
        assert_eq!(blocked(Platform::Linux, &window("gnome-control-center")), Some(BlockReason::SecuritySettings));
        let mut wrapped = window("python3");
        wrapped.class_name = Some("xterm\0XTerm".into());
        assert_eq!(blocked(Platform::Linux, &wrapped), Some(BlockReason::Terminal));
    }

    #[test]
    fn ordinary_apps_are_not_on_the_list() {
        assert_eq!(blocked(Platform::Windows, &window("notepad.exe")), None);
        assert_eq!(blocked(Platform::Windows, &window("chrome.exe")), None);
        assert_eq!(blocked(Platform::Windows, &window("explorer.exe")), None);
        assert_eq!(blocked(Platform::MacOs, &window("com.apple.textedit")), None);
        assert_eq!(blocked(Platform::MacOs, &window("com.apple.safari")), None);
        assert_eq!(blocked(Platform::Linux, &window("firefox")), None);
        assert_eq!(blocked(Platform::Linux, &window("gedit")), None);
    }

    #[test]
    fn the_exe_path_is_judged_even_when_the_key_is_something_else() {
        let mut renamed = window("harmless");
        renamed.app.exe = Some("C:\\Windows\\System32\\cmd.exe".into());
        assert_eq!(blocked(Platform::Windows, &renamed), Some(BlockReason::Terminal));
    }

    #[test]
    fn own_window_elevated_window_and_nameless_process_are_blocked() {
        let mut own = window("notepad.exe");
        own.is_self = true;
        assert_eq!(blocked(Platform::Windows, &own), Some(BlockReason::OwnApp));
        let mut admin = window("notepad.exe");
        admin.elevated = Some(true);
        assert_eq!(blocked(Platform::Windows, &admin), Some(BlockReason::Elevated));
        assert_eq!(blocked(Platform::Windows, &window("")), Some(BlockReason::SystemDialog));
    }

    #[test]
    fn the_run_dialog_is_blocked_although_it_belongs_to_the_file_manager() {
        let mut run = window("explorer.exe");
        run.class_name = Some("#32770".into());
        run.launcher = true;
        assert_eq!(blocked(Platform::Windows, &run), Some(BlockReason::Launcher));
        // Any other dialog of the file manager stays an ordinary window.
        let mut properties = window("explorer.exe");
        properties.class_name = Some("#32770".into());
        assert_eq!(blocked(Platform::Windows, &properties), None);
    }

    #[test]
    fn system_launchers_are_blocked_on_every_platform() {
        for exe in ["SearchApp.exe", "SearchHost.exe", "PowerToys.PowerLauncher.exe", "Flow.Launcher.exe"] {
            assert_eq!(blocked(Platform::Windows, &window(exe)), Some(BlockReason::Launcher), "{exe}");
            assert_eq!(blocked_key(Platform::Windows, exe), Some(BlockReason::Launcher), "{exe}");
        }
        for bundle in ["com.apple.Spotlight", "com.raycast.macos", "com.runningwithcrayons.Alfred"] {
            assert_eq!(blocked(Platform::MacOs, &window(bundle)), Some(BlockReason::Launcher), "{bundle}");
        }
        for name in ["rofi", "krunner", "ulauncher", "dmenu_run"] {
            assert_eq!(blocked(Platform::Linux, &window(name)), Some(BlockReason::Launcher), "{name}");
        }
        // The Start menu itself only lists apps and stays approvable.
        assert_eq!(blocked(Platform::Windows, &window("StartMenuExperienceHost.exe")), None);
    }

    #[test]
    fn the_tools_the_first_windows_run_reached_are_on_the_list() {
        // Task Manager, the registry editor and a console are reached from the Run dialog.
        assert_eq!(blocked(Platform::Windows, &window("Taskmgr.exe")), Some(BlockReason::SecuritySettings));
        assert_eq!(blocked(Platform::Windows, &window("regedit.exe")), Some(BlockReason::SecuritySettings));
        let mut admin_prompt = window("cmd.exe");
        admin_prompt.elevated = Some(true);
        assert_eq!(blocked(Platform::Windows, &admin_prompt), Some(BlockReason::Elevated));
    }

    #[test]
    fn launcher_chords_are_blocked_on_the_platform_where_they_open_one() {
        use super::super::keys::parse_chord;
        let chord = |text: &str| parse_chord(text).unwrap();
        for keys in ["win+r", "Win+R", "win+s", "win+q"] {
            assert!(blocked_chord(Platform::Windows, &chord(keys)).is_some(), "{keys}");
        }
        assert!(blocked_chord(Platform::MacOs, &chord("cmd+space")).is_some());
        assert!(blocked_chord(Platform::Linux, &chord("alt+f2")).is_some());
        // Reload on macOS, a plain letter, and chords that only look alike.
        assert!(blocked_chord(Platform::MacOs, &chord("cmd+r")).is_none());
        for keys in ["r", "ctrl+r", "win+shift+r", "ctrl+s", "alt+f4", "win+d"] {
            assert!(blocked_chord(Platform::Windows, &chord(keys)).is_none(), "{keys}");
        }
    }

    #[test]
    fn a_blocked_key_cannot_be_approved() {
        assert_eq!(blocked_key(Platform::Windows, "PowerShell.exe"), Some(BlockReason::Terminal));
        assert_eq!(blocked_key(Platform::MacOs, "com.apple.Terminal"), Some(BlockReason::Terminal));
        assert_eq!(blocked_key(Platform::Windows, "notepad.exe"), None);
    }

    #[test]
    fn every_platform_covers_every_category_and_the_data_is_lower_case() {
        for platform in [Platform::Windows, Platform::MacOs, Platform::Linux] {
            for reason in [BlockReason::Terminal, BlockReason::PasswordManager, BlockReason::SystemDialog, BlockReason::SecuritySettings, BlockReason::Launcher] {
                assert!(rules(platform).iter().any(|r| r.reason == reason), "{platform:?} lacks {reason:?}");
            }
            for rule in rules(platform) {
                for entry in rule.apps.iter().chain(rule.classes) {
                    assert_eq!(*entry, entry.to_lowercase(), "{entry} must be lower case");
                    assert!(!entry.is_empty());
                }
            }
        }
    }
}
