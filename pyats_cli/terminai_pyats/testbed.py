"""Testbed loader with %ENV{} placeholder substitution.

Loads a pyATS testbed.yaml file and substitutes %ENV{VAR_NAME} placeholders
with values from a sibling .env file. This allows GUI-managed credentials
without embedding secrets in the testbed YAML.
"""

import os
import re
from pathlib import Path
from typing import Any, Dict

import yaml
from genie.testbed import load as genie_load

from .errors import PyatsError


def load_testbed_with_env(testbed_path: str):
    """Load a testbed.yaml and substitute %ENV{} placeholders from sibling .env.

    Args:
        testbed_path: Path to testbed.yaml file

    Returns:
        Genie Testbed object with credentials populated from .env

    Raises:
        PyatsError: If testbed file not found, .env missing, or env var undefined

    Example:
        testbed.yaml:
            devices:
              CORE1:
                credentials:
                  default:
                    username: "%ENV{CORE1_USERNAME}"
                    password: "%ENV{CORE1_PASSWORD}"

        .env:
            CORE1_USERNAME=admin
            CORE1_PASSWORD=secret123
    """
    testbed_path = Path(testbed_path).expanduser().resolve()

    if not testbed_path.exists():
        raise PyatsError(
            f"Testbed file not found: {testbed_path}",
            hint="Verify the testbed path or create one in Settings → pyATS"
        )

    # Load .env from same directory
    env_path = testbed_path.parent / ".env"
    if not env_path.exists():
        raise PyatsError(
            f"Environment file not found: {env_path}",
            hint="Testbed requires a sibling .env file with device credentials"
        )

    # The GUI-managed environment file is intentionally plaintext for the
    # existing standalone pyATS contract, but must remain owner-only.
    if os.name != "nt":
        os.chmod(env_path, 0o600)

    # Parse .env file into dict
    env_vars = _parse_env_file(env_path)

    # Load and process testbed YAML
    with open(testbed_path, "r") as f:
        testbed_dict = yaml.safe_load(f)

    # Substitute %ENV{VAR} placeholders recursively
    testbed_dict = _substitute_env_vars(testbed_dict, env_vars)

    # Convert to Genie Testbed object
    try:
        # Write temporary YAML with substituted values
        import tempfile
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as tmp:
            yaml.dump(testbed_dict, tmp)
            tmp_path = tmp.name

        try:
            return genie_load(tmp_path)
        finally:
            try:
                os.unlink(tmp_path)
            except FileNotFoundError:
                pass
    except Exception as exc:
        raise PyatsError(
            f"Failed to load testbed: {exc}",
            hint="Check testbed.yaml syntax and device definitions"
        )


def _parse_env_file(env_path: Path) -> Dict[str, str]:
    """Parse a .env file into a dict.

    Args:
        env_path: Path to .env file

    Returns:
        Dict mapping variable names to values
    """
    env_vars = {}
    with open(env_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            env_vars[key.strip()] = value.strip()
    return env_vars


def _substitute_env_vars(obj: Any, env_vars: Dict[str, str]) -> Any:
    """Recursively substitute %ENV{VAR} placeholders in a data structure.

    Args:
        obj: Python object (dict, list, str, etc.)
        env_vars: Dict of environment variable names to values

    Returns:
        Object with all %ENV{} placeholders replaced

    Raises:
        PyatsError: If a referenced env var is not defined
    """
    if isinstance(obj, dict):
        return {k: _substitute_env_vars(v, env_vars) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_substitute_env_vars(item, env_vars) for item in obj]
    elif isinstance(obj, str):
        # Find all %ENV{VAR_NAME} patterns
        pattern = r"%ENV\{([^}]+)\}"
        matches = re.findall(pattern, obj)

        for var_name in matches:
            if var_name not in env_vars:
                raise PyatsError(
                    f"Environment variable not found in .env: {var_name}",
                    hint=f"Add {var_name}=<value> to the .env file"
                )
            # Replace %ENV{VAR_NAME} with the actual value
            obj = obj.replace(f"%ENV{{{var_name}}}", env_vars[var_name])

        # Convert numeric strings to int/float if entire value was a placeholder
        if obj.isdigit():
            return int(obj)
        try:
            return float(obj)
        except ValueError:
            return obj
    else:
        return obj
