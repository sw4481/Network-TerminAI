//! sqlite-vec extension registration (Plan 12 Phase 1 Task 1.2).
//!
//! Decision B per `docs/rag/sqlite-vec-research.md`: register
//! `sqlite_vec::sqlite3_vec_init` once-per-process via
//! `rusqlite::ffi::sqlite3_auto_extension`. Every subsequent
//! `Connection::open*` automatically has the `vec0` virtual table
//! available.
//!
//! ## Order-of-operations
//!
//! `sqlite3_auto_extension` registers a hook that fires for every
//! **future** connection — connections opened before the hook is
//! installed do NOT pick up `vec0`. We side-step this by:
//!
//! 1. Calling [`enable_vec_extension`] up-front. It registers the
//!    auto-extension exactly once, then verifies vec_version() resolves
//!    on the connection the caller passed in. The verification will
//!    fail if the caller opened the connection BEFORE registering, so
//!    the bug is caught at boot rather than at first migration.
//! 2. Tests open `Connection::open_in_memory()` after calling
//!    `enable_vec_extension(&placeholder_conn)`. Because that helper
//!    registers globally, subsequent connections — including the one
//!    the test actually exercises — pick up vec0 transparently.
//!
//! Real callers (`db::open_and_migrate`, `RagStore::open_in_memory`)
//! follow the same recipe: register first, then verify.

use anyhow::{Context, Result};
use rusqlite::Connection;
use std::sync::Once;

static REGISTER_VEC: Once = Once::new();

/// Register `sqlite3_vec_init` as a SQLite auto-extension for the
/// current process. Idempotent across threads (gated by a `Once`). Must
/// be called BEFORE any connection that needs `vec0` is opened — which
/// in practice means it runs at the top of `db::open_and_migrate*` and
/// `RagStore::open_in_memory` before they call `Connection::open*`.
pub fn register_vec_auto_extension() {
    REGISTER_VEC.call_once(|| {
        // SAFETY: the C entrypoint signature for SQLite extensions is
        // `int (*)(sqlite3*, char**, const sqlite3_api_routines*)`.
        // `sqlite_vec::sqlite3_vec_init` matches that signature exactly;
        // the transmute through `*const ()` is the recipe published in
        // sqlite-vec's official Rust guide and the upstream crate's own
        // tests.
        unsafe {
            let entrypoint = std::mem::transmute::<
                *const (),
                rusqlite::auto_extension::RawAutoExtension,
            >(sqlite_vec::sqlite3_vec_init as *const ());
            rusqlite::ffi::sqlite3_auto_extension(Some(entrypoint));
        }
    });
}

/// Public Phase-1 API: register the auto-extension AND verify the
/// passed-in connection can resolve `vec_version()`. The verification
/// step catches "connection opened before registration" bugs early.
///
/// Plan 12 calls this from:
/// - `db::open_and_migrate*` BEFORE running migrations.
/// - `RagStore::open_in_memory` after opening its private connection.
/// - Phase 1 tests, before opening any connection that uses vec0.
pub fn enable_vec_extension(conn: &Connection) -> Result<()> {
    register_vec_auto_extension();
    let _: String = conn
        .query_row("SELECT vec_version()", [], |r| r.get(0))
        .context(
            "sqlite-vec auto-extension is not visible on this connection. \
             Was the connection opened BEFORE register_vec_auto_extension()? \
             Open new connections after enable_vec_extension() has run once.",
        )?;
    Ok(())
}
