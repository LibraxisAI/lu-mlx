//! Linux: X11 only, spoken directly through `x11rb` (the pure Rust client
//! `enigo` already uses), so the build needs no new system library.
//!
//! On Wayland an app can neither see other windows nor send them input, and
//! XWayland would only show the X11 apps and reach none of the others. So a
//! Wayland session gets one clear sentence instead of half a feature. No
//! accessibility tree yet.

use super::super::adapter::{Desktop, InputOp};
use super::super::blocklist::Platform;
use super::super::types::{AppIdentity, MonitorInfo, PlatformError, PlatformResult, Rect, WindowInfo};
use super::{input, Worker};
use image::RgbaImage;
use std::os::unix::fs::MetadataExt;
use x11rb::connection::Connection;
use x11rb::protocol::randr::ConnectionExt as _;
use x11rb::protocol::xproto::{Atom, AtomEnum, ClientMessageEvent, ConnectionExt as _, EventMask, ImageFormat, Window};
use x11rb::rust_connection::RustConnection;

pub struct LinuxDesktop {
    own_pid: u32,
    worker: PlatformResult<Worker>,
}

impl LinuxDesktop {
    pub fn new(own_pid: u32) -> Self {
        Self { own_pid, worker: Worker::spawn("lu-computer", || {}) }
    }

    fn run<R: Send + 'static>(&self, work: impl FnOnce() -> PlatformResult<R> + Send + 'static) -> PlatformResult<R> {
        match &self.worker {
            Ok(worker) => worker.run(work),
            Err(error) => Err(error.clone()),
        }
    }
}

/// Is this a Wayland session? Pure, so it is tested.
pub fn is_wayland(session_type: Option<&str>, wayland_display: Option<&str>) -> bool {
    session_type.is_some_and(|t| t.eq_ignore_ascii_case("wayland")) || wayland_display.is_some_and(|d| !d.is_empty())
}

fn session_check() -> PlatformResult<()> {
    let session_type = std::env::var("XDG_SESSION_TYPE").ok();
    let wayland_display = std::env::var("WAYLAND_DISPLAY").ok();
    if is_wayland(session_type.as_deref(), wayland_display.as_deref()) {
        return Err(PlatformError::unavailable(
            "Computer control needs an X11 session. This desktop runs Wayland, where an app cannot see other windows or send them input. Sign in with an X11 (Xorg) session to use it.",
        ));
    }
    if std::env::var("DISPLAY").map(|d| d.is_empty()).unwrap_or(true) {
        return Err(PlatformError::unavailable("Computer control needs a graphical X11 session, and none was found."));
    }
    Ok(())
}

fn x_failed() -> PlatformError {
    PlatformError::failed("The X server did not answer.")
}

struct X {
    conn: RustConnection,
    root: Window,
}

impl X {
    fn connect() -> PlatformResult<X> {
        session_check()?;
        let (conn, screen) = RustConnection::connect(None).map_err(|_| PlatformError::unavailable("LU could not connect to the X server of this desktop."))?;
        let root = conn.setup().roots.get(screen).ok_or_else(x_failed)?.root;
        Ok(X { conn, root })
    }

    fn atom(&self, name: &str) -> PlatformResult<Atom> {
        Ok(self.conn.intern_atom(false, name.as_bytes()).map_err(|_| x_failed())?.reply().map_err(|_| x_failed())?.atom)
    }

    fn property(&self, window: Window, name: &str, max_words: u32) -> Option<x11rb::protocol::xproto::GetPropertyReply> {
        let atom = self.atom(name).ok()?;
        self.conn.get_property(false, window, atom, AtomEnum::ANY, 0, max_words).ok()?.reply().ok().filter(|r| r.value_len > 0)
    }

    fn cardinals(&self, window: Window, name: &str) -> Vec<u32> {
        self.property(window, name, 4096).and_then(|r| r.value32().map(|v| v.collect())).unwrap_or_default()
    }

    fn text(&self, window: Window, name: &str) -> Option<String> {
        self.property(window, name, 1024).map(|r| String::from_utf8_lossy(&r.value).into_owned())
    }

    fn describe(&self, window: Window, own_pid: u32) -> Option<WindowInfo> {
        let geometry = self.conn.get_geometry(window).ok()?.reply().ok()?;
        let origin = self.conn.translate_coordinates(window, self.root, 0, 0).ok()?.reply().ok()?;
        let pid = self.cardinals(window, "_NET_WM_PID").first().copied().unwrap_or(0);
        let class = self.text(window, "WM_CLASS").map(|c| c.trim_end_matches('\0').to_string());
        let class_name = class.as_deref().and_then(|c| c.rsplit('\0').next()).unwrap_or_default().to_string();
        let exe = (pid != 0).then(|| std::fs::read_link(format!("/proc/{pid}/exe")).ok()).flatten().map(|p| p.to_string_lossy().into_owned());
        let file = exe.as_deref().map(|p| p.rsplit('/').next().unwrap_or(p).to_string()).unwrap_or_default();
        let key = if file.is_empty() { class_name.to_lowercase() } else { file.to_lowercase() };
        let name = if class_name.is_empty() { file.clone() } else { class_name };
        let root_owned = (pid != 0).then(|| std::fs::metadata(format!("/proc/{pid}")).ok()).flatten().map(|m| m.uid() == 0);
        let hidden = self.atom("_NET_WM_STATE_HIDDEN").ok();
        let minimized = hidden.is_some_and(|hidden| self.cardinals(window, "_NET_WM_STATE").contains(&hidden));
        Some(WindowInfo {
            id: u64::from(window),
            pid,
            app: AppIdentity { key, name, exe, bundle_id: None },
            title: self.text(window, "_NET_WM_NAME").or_else(|| self.text(window, "WM_NAME")).unwrap_or_default(),
            class_name: class,
            rect: Rect::new(i32::from(origin.dst_x), i32::from(origin.dst_y), i32::from(geometry.width), i32::from(geometry.height)),
            minimized,
            elevated: root_owned,
            is_self: pid != 0 && pid == own_pid,
            launcher: false,
            capture_excluded: false,
        })
    }

    fn windows(&self, own_pid: u32) -> Vec<WindowInfo> {
        // The window manager lists its clients bottom to top.
        let mut stack = self.cardinals(self.root, "_NET_CLIENT_LIST_STACKING");
        if stack.is_empty() {
            stack = self.cardinals(self.root, "_NET_CLIENT_LIST");
        }
        stack.into_iter().rev().filter_map(|w| self.describe(w, own_pid)).collect()
    }

    fn monitors(&self) -> PlatformResult<Vec<MonitorInfo>> {
        let reply = self.conn.randr_get_monitors(self.root, true).map_err(|_| x_failed())?.reply().map_err(|_| x_failed())?;
        let mut out: Vec<MonitorInfo> = reply
            .monitors
            .iter()
            .map(|m| MonitorInfo {
                id: m.name,
                name: self.conn.get_atom_name(m.name).ok().and_then(|c| c.reply().ok()).map(|r| String::from_utf8_lossy(&r.name).into_owned()).unwrap_or_default(),
                rect: Rect::new(i32::from(m.x), i32::from(m.y), i32::from(m.width), i32::from(m.height)),
                pixel_width: u32::from(m.width),
                pixel_height: u32::from(m.height),
                scale_factor: 1.0,
                primary: m.primary,
            })
            .collect();
        if out.is_empty() {
            return Err(PlatformError::failed("The X server reported no display."));
        }
        if !out.iter().any(|m| m.primary) {
            out[0].primary = true;
        }
        Ok(out)
    }

    fn capture(&self, monitor_id: u32) -> PlatformResult<RgbaImage> {
        let monitor = self.monitors()?.into_iter().find(|m| m.id == monitor_id).ok_or_else(|| PlatformError::failed("That display is not connected any more."))?;
        let rect = monitor.rect;
        let reply = self
            .conn
            .get_image(ImageFormat::Z_PIXMAP, self.root, rect.x as i16, rect.y as i16, rect.width as u16, rect.height as u16, !0)
            .map_err(|_| x_failed())?
            .reply()
            .map_err(|_| PlatformError::failed("The X server did not hand out the screen."))?;
        bgrx_to_rgba(&reply.data, rect.width as u32, rect.height as u32)
            .ok_or_else(|| PlatformError::failed("This X server uses a pixel format LU cannot read. A 24 or 32 bit display is needed."))
    }
}

/// X11 hands out 32 bits per pixel as blue, green, red and a pad byte on
/// every common little endian setup. Anything else is refused, not guessed.
pub fn bgrx_to_rgba(data: &[u8], width: u32, height: u32) -> Option<RgbaImage> {
    let expected = (width as usize).checked_mul(height as usize)?.checked_mul(4)?;
    if expected == 0 || data.len() != expected {
        return None;
    }
    let mut rgba = Vec::with_capacity(expected);
    // The length check above makes the remainder empty.
    for pixel in data.as_chunks::<4>().0 {
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
    }
    RgbaImage::from_raw(width, height, rgba)
}

impl Desktop for LinuxDesktop {
    fn platform(&self) -> Platform {
        Platform::Linux
    }

    fn input_ready(&self) -> PlatformResult<()> {
        session_check()?;
        self.run(input::ready)
    }

    fn monitors(&self) -> PlatformResult<Vec<MonitorInfo>> {
        X::connect()?.monitors()
    }

    fn capture(&self, monitor_id: u32) -> PlatformResult<RgbaImage> {
        X::connect()?.capture(monitor_id)
    }

    fn cursor(&self) -> PlatformResult<(i32, i32)> {
        let x = X::connect()?;
        let pointer = x.conn.query_pointer(x.root).map_err(|_| x_failed())?.reply().map_err(|_| x_failed())?;
        Ok((i32::from(pointer.root_x), i32::from(pointer.root_y)))
    }

    fn windows(&self) -> PlatformResult<Vec<WindowInfo>> {
        Ok(X::connect()?.windows(self.own_pid))
    }

    fn foreground(&self) -> PlatformResult<Option<WindowInfo>> {
        let x = X::connect()?;
        let active = x.cardinals(x.root, "_NET_ACTIVE_WINDOW").first().copied().unwrap_or(0);
        Ok(if active == 0 { None } else { x.describe(active, self.own_pid) })
    }

    fn focus_window(&self, window: &WindowInfo) -> PlatformResult<()> {
        let x = X::connect()?;
        let target = window.id as Window;
        // Ask the window manager, as a pager would (source indication 2).
        let event = ClientMessageEvent::new(32, target, x.atom("_NET_ACTIVE_WINDOW")?, [2u32, 0, 0, 0, 0]);
        x.conn
            .send_event(false, x.root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, event)
            .map_err(|_| x_failed())?;
        x.conn.flush().map_err(|_| x_failed())?;
        Ok(())
    }

    fn input(&self, op: &InputOp) -> PlatformResult<()> {
        let op = op.clone();
        self.run(move || input::with_enigo(|enigo| input::apply(enigo, &op)))
    }

    fn release_all(&self) {
        let _ = self.run(|| {
            input::with_enigo(|enigo| {
                input::release_all(enigo);
                Ok(())
            })
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wayland_is_recognised_from_the_session_environment() {
        assert!(is_wayland(Some("wayland"), None));
        assert!(is_wayland(Some("Wayland"), Some("wayland-0")));
        assert!(is_wayland(None, Some("wayland-0")));
        assert!(!is_wayland(Some("x11"), None));
        assert!(!is_wayland(Some("x11"), Some("")));
        assert!(!is_wayland(None, None));
    }

    #[test]
    fn x11_pixels_are_reordered_and_made_opaque() {
        let image = bgrx_to_rgba(&[10, 20, 30, 0, 1, 2, 3, 0], 2, 1).unwrap();
        assert_eq!(image.get_pixel(0, 0).0, [30, 20, 10, 255]);
        assert_eq!(image.get_pixel(1, 0).0, [3, 2, 1, 255]);
        assert!(bgrx_to_rgba(&[0; 6], 2, 1).is_none());
        assert!(bgrx_to_rgba(&[], 0, 0).is_none());
    }

    /// The one test here that talks to an X server, so it is ignored unless
    /// asked for. Under a virtual framebuffer:
    ///
    ///   xvfb-run -a -s "-screen 0 1280x800x24" \
    ///     cargo test -- --ignored --test-threads=1 a_running_x_server
    ///
    /// It puts a window of a known colour on the screen and then goes through
    /// the public path: the screen is read back with that colour in RGBA
    /// order, the pointer lands where it was sent, and a typed letter arrives
    /// as a key press. A virtual framebuffer has no window manager, so the
    /// window list and focusing a window are not covered.
    #[test]
    #[ignore = "needs an X server, run it under xvfb-run"]
    fn a_running_x_server_shows_its_screen_and_takes_pointer_and_keys() {
        use std::time::{Duration, Instant};
        use x11rb::protocol::xproto::{CreateWindowAux, InputFocus, WindowClass};
        use x11rb::protocol::Event;

        let (conn, screen) = RustConnection::connect(None).expect("an X server on DISPLAY");
        let root = conn.setup().roots[screen].root;
        let round_trip = || {
            conn.get_input_focus().expect("request").reply().expect("the server answers");
        };

        let window = conn.generate_id().expect("a window id");
        let look = CreateWindowAux::new().background_pixel(0x0033_66CC).override_redirect(1).event_mask(EventMask::KEY_PRESS);
        conn.create_window(x11rb::COPY_DEPTH_FROM_PARENT, window, root, 0, 0, 120, 90, 0, WindowClass::INPUT_OUTPUT, 0, &look).expect("create");
        conn.map_window(window).expect("map");
        round_trip();
        conn.set_input_focus(InputFocus::POINTER_ROOT, window, x11rb::CURRENT_TIME).expect("focus");
        round_trip();

        let desk = LinuxDesktop::new(std::process::id());
        desk.input_ready().expect("input is ready in an X11 session");

        let monitors = desk.monitors().expect("the server reports a display");
        let primary = monitors.iter().find(|m| m.primary).expect("one display is primary");
        let shot = desk.capture(primary.id).expect("the screen can be read");
        assert_eq!((shot.width(), shot.height()), (primary.pixel_width, primary.pixel_height));
        assert_eq!(shot.get_pixel(10, 10).0, [0x33, 0x66, 0xCC, 255], "the window's colour, in RGBA order");

        desk.input(&InputOp::Move { x: 200, y: 150 }).expect("the pointer can be moved");
        let deadline = Instant::now() + Duration::from_secs(3);
        while desk.cursor().expect("the pointer can be read") != (200, 150) {
            assert!(Instant::now() < deadline, "the pointer never reached 200,150, it is at {:?}", desk.cursor());
            std::thread::sleep(Duration::from_millis(20));
        }

        desk.input(&InputOp::Text("a".to_string())).expect("a letter can be typed");
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match conn.poll_for_event().expect("the connection holds") {
                Some(Event::KeyPress(_)) => break,
                Some(_) => {}
                None => {
                    assert!(Instant::now() < deadline, "the typed letter never arrived as a key press");
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        desk.release_all();
    }
}
