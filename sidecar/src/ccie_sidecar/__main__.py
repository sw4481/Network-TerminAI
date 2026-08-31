"""Entry point: `python -m ccie_sidecar`."""
from ccie_sidecar.tls import install_system_trust_store
from ccie_sidecar.server import run_loop


if __name__ == "__main__":
    install_system_trust_store()
    run_loop()
