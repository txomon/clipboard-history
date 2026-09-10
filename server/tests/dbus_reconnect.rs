#![cfg(feature = "dbus")]

use std::{
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

use tokio::time::{Instant, sleep};
use zbus::{Proxy, connection::Builder, fdo::DBusProxy};

const BUS_NAME: &str = "com.github.SUPERCILEX.Ringboard";
const OBJECT_PATH: &str = "/com/github/SUPERCILEX/Ringboard";
const INTERFACE: &str = "com.github.SUPERCILEX.Ringboard1";

/// Start a session bus on a fixed socket path.
///
/// `dbus-launch` picks a random path, so it cannot express the case we care
/// about: a replacement daemon taking over the same address, which is what
/// happens under systemd where `dbus.socket` owns the listening socket and
/// only `dbus-broker.service` is restarted.
fn start_bus(sock: &Path) -> Option<u32> {
    let _ = std::fs::remove_file(sock);
    let out = Command::new("dbus-daemon")
        .arg("--session")
        .arg(format!("--address=unix:path={}", sock.display()))
        .arg("--print-pid")
        .arg("--fork")
        .output()
        .ok()?;
    String::from_utf8(out.stdout).ok()?.trim().parse().ok()
}

fn kill_pid(pid: u32) {
    let _ = Command::new("kill").arg(pid.to_string()).status();
}

/// Whether anyone currently owns the ringboard name on the bus at `addr`.
/// Every failure mode (bus absent, connect refused) counts as "not owned".
async fn name_owned(addr: &str) -> bool {
    let Ok(builder) = Builder::address(addr) else {
        return false;
    };
    let Ok(conn) = builder.build().await else {
        return false;
    };
    let Ok(dbus) = DBusProxy::new(&conn).await else {
        return false;
    };
    let Ok(name) = BUS_NAME.try_into() else {
        return false;
    };
    matches!(dbus.name_has_owner(name).await, Ok(true))
}

async fn wait_for_name(addr: &str, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if name_owned(addr).await {
            return true;
        }
        sleep(Duration::from_millis(200)).await;
    }
    false
}

#[tokio::test(flavor = "current_thread")]
async fn reclaims_bus_name_after_the_session_bus_restarts() {
    if which::which("dbus-daemon").is_err() {
        eprintln!("dbus-daemon not available; skipping");
        return;
    }
    let tmpdir = tempfile::tempdir().unwrap();
    let sock = tmpdir.path().join("bus");
    let addr = format!("unix:path={}", sock.display());

    let Some(bus1) = start_bus(&sock) else {
        eprintln!("could not start dbus-daemon; skipping");
        return;
    };
    let mut server = Command::new(env!("CARGO_BIN_EXE_ringboard-server"))
        .env("XDG_DATA_HOME", tmpdir.path())
        .env("DBUS_SESSION_BUS_ADDRESS", &addr)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    assert!(
        wait_for_name(&addr, Duration::from_secs(5)).await,
        "precondition failed: server never claimed {BUS_NAME} on the first bus"
    );

    kill_pid(bus1);
    let bus2 = start_bus(&sock).expect("replacement bus failed to start");

    let recovered = wait_for_name(&addr, Duration::from_secs(15)).await;

    // Owning the name again is not enough; the interface must answer.
    let answers = if recovered {
        match Builder::address(addr.as_str()).unwrap().build().await {
            Ok(conn) => match Proxy::new_owned(conn, BUS_NAME, OBJECT_PATH, INTERFACE).await {
                Ok(p) => {
                    let res: zbus::Result<(Vec<(u64, String, Vec<u8>)>, u64)> =
                        p.call("Search", &("", 0u64, 1u64)).await;
                    res.is_ok()
                }
                Err(_) => false,
            },
            Err(_) => false,
        }
    } else {
        false
    };

    // Tear down before asserting so a failure cannot leak processes.
    let _ = server.kill();
    kill_pid(bus2);

    assert!(
        recovered,
        "server did not re-claim {BUS_NAME} after the session bus restarted"
    );
    assert!(answers, "re-claimed {BUS_NAME} but the interface did not answer");
}
