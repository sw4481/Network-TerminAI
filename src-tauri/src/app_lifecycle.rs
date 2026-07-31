#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WindowCloseDisposition {
    ExitApplication,
    CloseWindowOnly,
}

pub(super) fn close_disposition(window_label: &str) -> WindowCloseDisposition {
    if window_label == "main" {
        WindowCloseDisposition::ExitApplication
    } else {
        WindowCloseDisposition::CloseWindowOnly
    }
}

#[cfg(test)]
mod tests {
    use super::{close_disposition, WindowCloseDisposition};

    #[test]
    fn main_window_close_requests_application_exit() {
        assert_eq!(
            close_disposition("main"),
            WindowCloseDisposition::ExitApplication
        );
    }

    #[test]
    fn secondary_window_closes_stay_local() {
        for label in ["editor-00000000-0000-0000-0000-000000000001", "browser-1"] {
            assert_eq!(
                close_disposition(label),
                WindowCloseDisposition::CloseWindowOnly,
                "secondary window {label} must not terminate the app"
            );
        }
    }
}
