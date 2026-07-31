//! Zed Mode Phase 6 Git services.
//!
//! Tauri commands are intentionally thin adapters. Repository discovery,
//! state calculation, mutation serialization, history/diff loading, and
//! worktree watching live here so every Git surface shares one authority.

pub mod github_auth;
pub mod repository_service;

pub use github_auth::GitHubAuthManager;
pub use repository_service::GitRepositoryService;
