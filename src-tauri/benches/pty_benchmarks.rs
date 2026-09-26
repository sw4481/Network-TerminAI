use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use std::time::Duration;
use tokio::sync::mpsc;

// Import PTY modules
use ccie_terminal_lib::command_parser::Parser;
use ccie_terminal_lib::pty::{PtyEvent, PtyOptions};

/// Benchmark PTY write performance with varying payload sizes
fn bench_pty_write(c: &mut Criterion) {
    let mut group = c.benchmark_group("pty_write");

    // Test different payload sizes: 1KB, 10KB, 100KB
    for size in [1024, 10240, 102400].iter() {
        group.throughput(Throughput::Bytes(*size as u64));
        group.bench_with_input(BenchmarkId::from_parameter(size), size, |b, &size| {
            // Setup: Create a runtime and spawn a PTY
            let rt = tokio::runtime::Runtime::new().unwrap();
            let payload = vec![b'x'; size];

            b.iter(|| {
                rt.block_on(async {
                    let (tx, mut rx) = mpsc::channel::<PtyEvent>(100);

                    // Spawn PTY (this is expensive, but necessary for the benchmark)
                    let opts = PtyOptions {
                        shell: "/bin/sh".to_string(),
                        args: vec!["-c".to_string(), "cat".to_string()],
                        cwd: "/tmp".to_string(),
                        cols: 80,
                        rows: 24,
                        pane_id: None,
                        claude_config_dir: None,
                    };

                    // Measure write operation
                    if let Ok(handle) = ccie_terminal_lib::pty::spawn_pty(opts, tx).await {
                        let _ = handle.write(black_box(&payload));
                        // Clean up
                        let _ = handle.kill();
                    }

                    // Drain channel
                    while rx.try_recv().is_ok() {}
                });
            });
        });
    }
    group.finish();
}

/// Benchmark command parser performance with varying input sizes
fn bench_command_parser(c: &mut Criterion) {
    let mut group = c.benchmark_group("command_parser");

    // Test parsing different amounts of terminal output
    for size in [100, 1000, 10000].iter() {
        group.throughput(Throughput::Bytes(*size as u64));
        group.bench_with_input(BenchmarkId::from_parameter(size), size, |b, &size| {
            let input = vec![b'A'; size];

            b.iter(|| {
                let mut parser = Parser::new();
                let events = parser.feed(black_box(&input));
                black_box(events);
            });
        });
    }
    group.finish();
}

/// Benchmark PTY read loop throughput
fn bench_pty_read_throughput(c: &mut Criterion) {
    let mut group = c.benchmark_group("pty_read_throughput");
    group.sample_size(20); // Reduce sample size for expensive operations
    group.measurement_time(Duration::from_secs(10));

    group.bench_function("read_1000_lines", |b| {
        let rt = tokio::runtime::Runtime::new().unwrap();

        b.iter(|| {
            rt.block_on(async {
                let (tx, mut rx) = mpsc::channel::<PtyEvent>(1000);

                let opts = PtyOptions {
                    shell: "/bin/sh".to_string(),
                    args: vec![
                        "-c".to_string(),
                        "for i in $(seq 1 1000); do echo line_$i; done".to_string(),
                    ],
                    cwd: "/tmp".to_string(),
                    cols: 80,
                    rows: 24,
                    pane_id: None,
                    claude_config_dir: None,
                };

                if let Ok(handle) = ccie_terminal_lib::pty::spawn_pty(opts, tx).await {
                    let mut event_count = 0;
                    let mut exit_received = false;

                    // Read all events until exit
                    while let Some(event) = rx.recv().await {
                        event_count += 1;
                        if matches!(event, PtyEvent::Exit { .. }) {
                            exit_received = true;
                            break;
                        }
                    }

                    black_box((event_count, exit_received));
                    let _ = handle.kill();
                }
            });
        });
    });

    group.finish();
}

/// Benchmark PTY resize operations
fn bench_pty_resize(c: &mut Criterion) {
    let mut group = c.benchmark_group("pty_resize");

    group.bench_function("resize_operations", |b| {
        let rt = tokio::runtime::Runtime::new().unwrap();

        b.iter(|| {
            rt.block_on(async {
                let (tx, _rx) = mpsc::channel::<PtyEvent>(100);

                let opts = PtyOptions {
                    shell: "/bin/sh".to_string(),
                    args: vec![],
                    cwd: "/tmp".to_string(),
                    cols: 80,
                    rows: 24,
                    pane_id: None,
                    claude_config_dir: None,
                };

                if let Ok(handle) = ccie_terminal_lib::pty::spawn_pty(opts, tx).await {
                    // Perform multiple resize operations
                    for cols in [80, 120, 160, 80].iter() {
                        let _ = handle.resize(black_box(*cols), 24);
                    }
                    let _ = handle.kill();
                }
            });
        });
    });

    group.finish();
}

/// Benchmark channel throughput for PTY events
fn bench_channel_throughput(c: &mut Criterion) {
    let mut group = c.benchmark_group("channel_throughput");

    for buffer_size in [10, 100, 1000].iter() {
        group.bench_with_input(
            BenchmarkId::from_parameter(buffer_size),
            buffer_size,
            |b, &buffer_size| {
                let rt = tokio::runtime::Runtime::new().unwrap();

                b.iter(|| {
                    rt.block_on(async {
                        let (tx, mut rx) = mpsc::channel::<PtyEvent>(buffer_size);

                        // Spawn sender task
                        let send_handle = tokio::spawn(async move {
                            for i in 0..1000 {
                                let event = PtyEvent::Output {
                                    bytes: format!("output_{}", i).into_bytes(),
                                };
                                if tx.send(event).await.is_err() {
                                    break;
                                }
                            }
                        });

                        // Receiver task
                        let recv_handle = tokio::spawn(async move {
                            let mut count = 0;
                            while let Some(_event) = rx.recv().await {
                                count += 1;
                                if count >= 1000 {
                                    break;
                                }
                            }
                            count
                        });

                        let _ = tokio::join!(send_handle, recv_handle);
                    });
                });
            },
        );
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_command_parser,
    bench_pty_write,
    bench_pty_resize,
    bench_channel_throughput,
    bench_pty_read_throughput
);
criterion_main!(benches);
