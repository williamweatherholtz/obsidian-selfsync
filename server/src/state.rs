#![allow(dead_code)]
use std::path::Path;

#[derive(Clone)]
pub struct AppState {}

impl AppState {
    pub fn for_test(_data_root: &Path) -> Self { AppState {} }
}
