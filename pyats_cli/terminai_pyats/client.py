"""PyatsClient: main entry point for calling pyATS verbs.

Provides a unified interface for loading testbeds and dispatching verb calls
with envelope responses.
"""

import importlib
from typing import Any, Dict

from .errors import PyatsError, to_envelope
from .testbed import load_testbed_with_env


def _kebab_to_snake(name: str) -> str:
    """Convert kebab-case to snake_case for module lookup."""
    return name.replace("-", "_")


class PyatsClient:
    """Main client for pyATS verb dispatch.

    Usage:
        client = PyatsClient.from_testbed("testbed.yaml")
        result = client.call("run-show-command", device="CORE1", command="show version")
        print(result)  # {ok, data, meta}
        client.disconnect_all()
    """

    def __init__(self, testbed):
        """Initialize client with a Genie testbed.

        Args:
            testbed: Genie Testbed object
        """
        self.testbed = testbed

    @classmethod
    def from_testbed(cls, testbed_path: str) -> "PyatsClient":
        """Load a testbed and create a client.

        Args:
            testbed_path: Path to testbed.yaml file

        Returns:
            PyatsClient instance

        Raises:
            PyatsError: If testbed cannot be loaded
        """
        testbed = load_testbed_with_env(testbed_path)
        return cls(testbed)

    def call(self, verb: str, **kwargs) -> Dict[str, Any]:
        """Call a pyATS verb and return its envelope.

        Args:
            verb: Verb name in kebab-case (e.g., "run-show-command")
            **kwargs: Verb-specific arguments

        Returns:
            Envelope dict with {ok, data/error, meta}

        Examples:
            >>> client.call("list-devices")
            {'ok': True, 'data': [...], 'meta': {...}}

            >>> client.call("run-show-command", device="CORE1", command="show version")
            {'ok': True, 'data': {...}, 'meta': {...}}
        """
        try:
            # Convert verb name to module name (e.g., "run-show-command" -> "run_show_command")
            module_name = _kebab_to_snake(verb)

            # Dynamically import the verb module
            try:
                verb_module = importlib.import_module(f"terminai_pyats.verbs.{module_name}")
            except ModuleNotFoundError:
                raise PyatsError(
                    f"Unknown verb: {verb}",
                    hint="Use 'pyats-cli tools list' to see available verbs"
                )

            # Get the verb function (same name as module)
            verb_func = getattr(verb_module, module_name)

            # Call the verb with testbed + kwargs
            return verb_func(self.testbed, **kwargs)

        except PyatsError:
            # Re-raise PyatsErrors as-is (they already have good messages)
            raise
        except Exception as exc:
            # Wrap unexpected errors as error envelope
            envelope = to_envelope(exc)
            return envelope

    def disconnect_all(self):
        """Disconnect all devices in the testbed.

        Call this when done with the client to clean up connections.
        """
        for device in self.testbed.devices.values():
            try:
                if device.is_connected():
                    device.disconnect()
            except Exception:
                # Ignore disconnect errors
                pass
