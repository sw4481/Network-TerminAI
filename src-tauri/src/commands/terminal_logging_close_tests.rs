use super::*;
use crate::terminal_logging::{TerminalLogManager, TerminalLogMode};

#[tokio::test]
async fn explicit_close_drains_already_queued_output_before_stopping_log() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("close-tail.txt");
    let logging = Arc::new(TerminalLogManager::default());
    logging
        .start(
            "pane",
            "generation",
            &path,
            TerminalLogMode::Create,
            Arc::new(|_| {}),
        )
        .unwrap();
    logging.output("pane", "generation", b"already forwarded\n");
    let drain = Arc::new(PtyOutputDrain::new());
    let (tx, mut rx) = tokio::sync::mpsc::channel(4);
    tx.send(PtyEvent::Output {
        bytes: b"queued tail\n".to_vec(),
    })
    .await
    .unwrap();
    let loop_logging = logging.clone();
    let loop_drain = drain.clone();
    let event_loop = tokio::spawn(async move {
        // Model an output loop that is busy until the explicit close boundary.
        loop_drain.request.notified().await;
        let mut closing = false;
        while let Some(event) = loop_drain.next_event(&mut rx, &mut closing).await {
            if let PtyEvent::Output { bytes } = event {
                loop_logging.output("pane", "generation", &bytes);
            }
        }
        loop_logging.stop("pane", Some("generation"));
        loop_drain.drained.send_replace(true);
    });
    stop_terminal_log_after_output(
        logging,
        "pane".into(),
        "generation".into(),
        Some(drain.clone()),
    )
    .await
    .unwrap();
    // Keeps this reproduction finite with the old Stop-before-drain ordering.
    drain.request_close();
    drop(tx);
    event_loop.await.unwrap();
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "already forwarded\nqueued tail\n"
    );
}

#[tokio::test]
async fn receiver_close_rejects_new_output_and_drains_a_finite_backlog() {
    let drain = PtyOutputDrain::new();
    let (tx, mut rx) = tokio::sync::mpsc::channel(4);
    tx.send(PtyEvent::Output {
        bytes: b"tail".to_vec(),
    })
    .await
    .unwrap();
    drain.request_close();
    let mut closing = false;
    assert!(matches!(
        drain.next_event(&mut rx, &mut closing).await,
        Some(PtyEvent::Output { .. })
    ));
    assert!(tx
        .send(PtyEvent::Output {
            bytes: b"later".to_vec()
        })
        .await
        .is_err());
    assert!(drain.next_event(&mut rx, &mut closing).await.is_none());
}
