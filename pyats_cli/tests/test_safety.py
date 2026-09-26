"""Tests for safety validator."""

import pytest
from terminai_pyats.safety import validate_show_command, has_destructive_keywords


def test_validate_show_command_allows_simple_show():
    """Simple show commands should pass."""
    result = validate_show_command("show version")
    assert result is True


def test_validate_show_command_allows_show_with_args():
    """Show commands with arguments should pass."""
    assert validate_show_command("show ip ospf neighbor") is True
    assert validate_show_command("show running-config interface Gi0/0") is True


def test_validate_show_command_blocks_pipes():
    """Commands with pipes should be blocked."""
    result = validate_show_command("show run | inc password")
    assert result is False


def test_validate_show_command_blocks_redirects():
    """Commands with redirects should be blocked."""
    assert validate_show_command("show version > file.txt") is False
    assert validate_show_command("show run >> log.txt") is False


def test_validate_show_command_blocks_config_commands():
    """Non-show commands should be blocked."""
    assert validate_show_command("configure terminal") is False
    assert validate_show_command("interface Gi0/0") is False
    assert validate_show_command("no shutdown") is False


def test_validate_show_command_case_insensitive():
    """Validation should be case-insensitive."""
    assert validate_show_command("SHOW VERSION") is True
    assert validate_show_command("Show Version") is True
    assert validate_show_command("SHOW RUN | INC password") is False


def test_has_destructive_keywords_detects_reload():
    """Detect reload keyword."""
    assert has_destructive_keywords("reload in 5") is True
    assert has_destructive_keywords("reload") is True


def test_has_destructive_keywords_detects_erase():
    """Detect erase keyword."""
    assert has_destructive_keywords("write erase") is True
    assert has_destructive_keywords("erase startup-config") is True


def test_has_destructive_keywords_detects_format():
    """Detect format keyword."""
    assert has_destructive_keywords("format flash:") is True


def test_has_destructive_keywords_detects_delete():
    """Detect delete keyword."""
    assert has_destructive_keywords("delete flash:config.txt") is True


def test_has_destructive_keywords_detects_boot_system():
    """Detect boot system changes."""
    assert has_destructive_keywords("boot system flash:new.bin") is True


def test_has_destructive_keywords_allows_safe_config():
    """Safe config should not trigger destructive flag."""
    assert has_destructive_keywords("interface Gi0/0\ndescription test") is False
    assert has_destructive_keywords("hostname CORE1") is False


def test_has_destructive_keywords_case_insensitive():
    """Keyword detection should be case-insensitive."""
    assert has_destructive_keywords("RELOAD") is True
    assert has_destructive_keywords("Erase startup") is True
