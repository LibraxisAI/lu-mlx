//! One adapter per operating system, and the two things they share: a worker
//! thread that owns what must not move between threads, and the mapping of
//! input events onto `enigo`.

use super::adapter::Desktop;
use super::types::{Permission, Permissions, PlatformError, PlatformResult};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

pub mod input;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod user_keys;
#[cfg(target_os = "windows")]
mod windows;

type Job = Box<dyn FnOnce() + Send>;

/// Runs a closure on the thread of the app's event loop and waits for it.
/// macOS wants simulated input to come from there.
pub type MainThread = Arc<dyn Fn(Job) -> bool + Send + Sync>;

/// A thread that lives as long as the adapter and runs its jobs one by one.
/// Input handles, COM and the DPI awareness of the thread stay on it. macOS
/// uses the main thread instead.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub struct Worker {
    jobs: Mutex<mpsc::Sender<Job>>,
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
impl Worker {
    pub fn spawn(name: &str, init: impl FnOnce() + Send + 'static) -> PlatformResult<Worker> {
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name(name.to_string())
            .spawn(move || {
                init();
                while let Ok(job) = rx.recv() {
                    job();
                }
            })
            .map_err(|_| worker_gone())?;
        Ok(Worker { jobs: Mutex::new(tx) })
    }

    pub fn run<R: Send + 'static>(&self, work: impl FnOnce() -> PlatformResult<R> + Send + 'static) -> PlatformResult<R> {
        let (done, result) = mpsc::channel();
        let job: Job = Box::new(move || {
            let _ = done.send(work());
        });
        self.jobs.lock().unwrap_or_else(|p| p.into_inner()).send(job).map_err(|_| worker_gone())?;
        result.recv().map_err(|_| worker_gone())?
    }
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn worker_gone() -> PlatformError {
    PlatformError::failed("The computer control worker is not running. Restart LU and try again.")
}

/// Run `work` on the main thread and wait for the answer.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn on_main<R: Send + 'static>(main: &MainThread, work: impl FnOnce() -> PlatformResult<R> + Send + 'static) -> PlatformResult<R> {
    let (done, result) = mpsc::channel();
    let accepted = main(Box::new(move || {
        let _ = done.send(work());
    }));
    if !accepted {
        return Err(PlatformError::failed("LU is shutting down, so computer control is not available."));
    }
    result.recv().map_err(|_| PlatformError::failed("LU is shutting down, so computer control is not available."))?
}

/// What the operating system has granted computer control. Only macOS has
/// permissions of this kind; everywhere else nothing is needed.
pub fn permissions() -> Permissions {
    #[cfg(target_os = "macos")]
    {
        macos::permissions()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Permissions { needed: false, accessibility: true, screen_recording: true }
    }
}

/// Ask the operating system for one permission and show the user where it is
/// granted. Does nothing where no permission is needed. Main thread on macOS.
pub fn request_permission(permission: Permission) {
    #[cfg(target_os = "macos")]
    {
        macos::request_permission(permission);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = permission;
    }
}

/// Make the operating system forget what it stored about this app for one
/// permission, so the next request starts clean. `app_id` is the bundle id.
/// Does nothing where no permission is needed.
pub fn forget_permission(permission: Permission, app_id: &str) -> PlatformResult<()> {
    #[cfg(target_os = "macos")]
    {
        macos::forget_permission(permission, app_id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (permission, app_id);
        Ok(())
    }
}

/// LU's main window becomes the panel while it has the foreground: hand the
/// foreground to the app below it. See the Windows adapter. `panel` is the
/// window handle.
#[cfg(target_os = "windows")]
pub fn give_up_foreground(panel: usize) -> bool {
    windows::give_up_foreground(panel)
}

/// The adapter for the system this build runs on. `own_pid` marks LU's own
/// windows.
pub fn native(own_pid: u32, main: MainThread) -> Arc<dyn Desktop> {
    #[cfg(target_os = "windows")]
    {
        let _ = main;
        Arc::new(windows::WindowsDesktop::new(own_pid))
    }
    #[cfg(target_os = "macos")]
    {
        Arc::new(macos::MacDesktop::new(own_pid, main))
    }
    #[cfg(target_os = "linux")]
    {
        let _ = main;
        Arc::new(linux::LinuxDesktop::new(own_pid))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (own_pid, main);
        Arc::new(unsupported::Unsupported)
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod unsupported {
    use super::super::adapter::{Desktop, InputOp};
    use super::super::blocklist::Platform;
    use super::super::types::{MonitorInfo, PlatformError, PlatformResult, WindowInfo};

    pub struct Unsupported;

    fn no<T>() -> PlatformResult<T> {
        Err(PlatformError::unavailable("Computer control is not available on this platform yet."))
    }

    impl Desktop for Unsupported {
        fn platform(&self) -> Platform {
            Platform::Linux
        }
        fn input_ready(&self) -> PlatformResult<()> {
            no()
        }
        fn monitors(&self) -> PlatformResult<Vec<MonitorInfo>> {
            no()
        }
        fn capture(&self, _monitor_id: u32) -> PlatformResult<image::RgbaImage> {
            no()
        }
        fn cursor(&self) -> PlatformResult<(i32, i32)> {
            no()
        }
        fn windows(&self) -> PlatformResult<Vec<WindowInfo>> {
            no()
        }
        fn foreground(&self) -> PlatformResult<Option<WindowInfo>> {
            no()
        }
        fn focus_window(&self, _window: &WindowInfo) -> PlatformResult<()> {
            no()
        }
        fn input(&self, _op: &InputOp) -> PlatformResult<()> {
            no()
        }
        fn release_all(&self) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_worker_runs_jobs_in_order_on_one_thread() {
        let worker = Worker::spawn("test-worker", || {}).unwrap();
        let first = worker.run(|| Ok(std::thread::current().id())).unwrap();
        let second = worker.run(|| Ok(std::thread::current().id())).unwrap();
        assert_eq!(first, second);
        assert_ne!(first, std::thread::current().id());
        let failed: PlatformResult<()> = worker.run(|| Err(PlatformError::failed("no")));
        assert_eq!(failed.unwrap_err().message, "no");
    }

    #[test]
    fn a_main_thread_that_is_gone_is_an_error_not_a_hang() {
        let refusing: MainThread = Arc::new(|_job| false);
        assert!(on_main(&refusing, || Ok(1)).is_err());
        let dropping: MainThread = Arc::new(|job| {
            drop(job);
            true
        });
        assert!(on_main(&dropping, || Ok(1)).is_err());
        let inline: MainThread = Arc::new(|job| {
            job();
            true
        });
        assert_eq!(on_main(&inline, || Ok(7)).unwrap(), 7);
    }
}
