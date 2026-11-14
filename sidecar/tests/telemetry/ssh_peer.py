"""Loopback-only malformed-packet fixture; never imports application state/config."""
import json
import logging
import socket
import sys
import threading
import time

import paramiko
from paramiko.message import Message


PRIVATE = "fixture-password-NEVER-LOG-6321 fixture-user T6RAW-73921"
logging.getLogger("paramiko").addHandler(logging.NullHandler())
logging.getLogger("paramiko").propagate = False


class PacketPeer(paramiko.Transport):
    def __init__(self, sock):
        super().__init__(sock)
        self.exec_ready = threading.Event()
        self.sent = {"early_data": 0, "channel_request": 0, "global_request": 0}

    def _send_message(self, message):
        super()._send_message(message)
        if message.asbytes()[:1] == bytes([99]):
            self.exec_ready.set()

    def _parse_channel_open(self, message):
        # Paramiko 5.0's handler table binds this override before open confirmation.
        peek = Message(message.asbytes())
        assert peek.get_text() == "session"
        recipient = peek.get_int()
        early = Message()
        early.add_byte(bytes([94]))
        early.add_int(recipient)
        early.add_string(PRIVATE)
        self._send_message(early)
        self.sent["early_data"] += 1
        super()._parse_channel_open(message)


class Server(paramiko.ServerInterface):
    def __init__(self, transport):
        self.transport = transport
        self.authenticated = 0

    def get_allowed_auths(self, username):
        return "password"

    def check_auth_password(self, username, password):
        if username == "fixture-user" and password == "fixture-password-NEVER-LOG-6321":
            self.authenticated += 1
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_exec_request(self, channel, command):
        assert command == b"show version"
        request = Message()
        request.add_byte(bytes([98]))
        request.add_int(channel.remote_chanid)
        request.add_string(PRIVATE)
        request.add_boolean(False)
        self.transport._send_message(request)
        self.transport.sent["channel_request"] += 1
        request = Message()
        request.add_byte(bytes([80]))
        request.add_string(PRIVATE)
        request.add_boolean(False)
        self.transport._send_message(request)
        self.transport.sent["global_request"] += 1
        return True


def run(key_path):
    transport = None
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(8)
        print(json.dumps({"port": listener.getsockname()[1]}), flush=True)
        connection, _ = listener.accept()
        try:
            transport = PacketPeer(connection)
            transport.add_server_key(paramiko.Ed25519Key.from_private_key_file(key_path))
            server = Server(transport)
            transport.start_server(server=server)
            channel = transport.accept(8)
            assert channel is not None and transport.exec_ready.wait(8)
            channel.sendall(b"T6RAW-73921 output\n")
            channel.send_exit_status(0)
            channel.shutdown_write()
            channel.close()
            deadline = time.monotonic() + 8
            while transport.is_active() and time.monotonic() < deadline:
                time.sleep(0.01)
        finally:
            if transport is not None:
                transport.close()
                transport.join(2)
            connection.close()
        assert transport is not None and not transport.is_alive()
        print(json.dumps({"sent": transport.sent, "authenticated": server.authenticated, "joined": True}), flush=True)


if __name__ == "__main__":
    try:
        run(sys.argv[1])
    except Exception as error:
        print(json.dumps({"error": type(error).__name__[:32]}), flush=True)
        sys.exit(1)
