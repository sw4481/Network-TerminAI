#!/bin/bash
# Install terminai-pyats in editable mode to sidecar venv
cd "$(dirname "$0")"
source ../sidecar/.venv/bin/activate
pip install -e .
