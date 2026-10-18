"""Native Windows MCP -> framed loopback RPC contract test.

Uses a fake 127.0.0.1 broker with a TEST token. No external agent provider,
SSH credentials, remote host, API keys or server-side daemon required.
The normal PowerShell smoke separately verifies missing-grant denial.
"""
import json
import os
import pathlib
import queue
import socket
import struct
import subprocess
import sys
import threading

EXECUTABLE = pathlib.Path(sys.argv[1]).resolve()
TEST_TOKEN = "passh7-ci-synthetic-token-not-a-secret"


def read_exact(connection, length):
    chunks = []
    while length:
        chunk = connection.recv(length)
        if not chunk:
            raise RuntimeError("MCP bridge closed while reading a framed request")
        chunks.append(chunk)
        length -= len(chunk)
    return b"".join(chunks)


def run():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(12)
        host, port = listener.getsockname()
        environment = os.environ.copy()
        environment.update({
            "PASSH7_BRIDGE_ADDR": f"{host}:{port}",
            "PASSH7_BRIDGE_TOKEN": TEST_TOKEN,
        })
        process = subprocess.Popen(
            [str(EXECUTABLE), "--passh7-mcp"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=environment,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        replies = queue.Queue()

        def collect_replies():
            while True:
                line = process.stdout.readline()
                if not line:
                    replies.put(None)
                    return
                replies.put(line)

        threading.Thread(target=collect_replies, daemon=True).start()
        try:
            def call(tool, arguments, expected_operation, expected_fields, result):
                identifier = call.counter
                call.counter += 1
                message = {
                    "jsonrpc": "2.0",
                    "id": identifier,
                    "method": "tools/call",
                    "params": {"name": tool, "arguments": arguments},
                }
                process.stdin.write(
                    (json.dumps(message, ensure_ascii=True) + "\n").encode("utf-8")
                )
                process.stdin.flush()
                with listener.accept()[0] as connection:
                    connection.settimeout(12)
                    frame_size = struct.unpack(">I", read_exact(connection, 4))[0]
                    if not 0 < frame_size < 1024 * 1024:
                        raise AssertionError("Invalid PaSSH7 loopback request length")
                    frame = json.loads(read_exact(connection, frame_size).decode("utf-8"))
                    assert frame["token"] == TEST_TOKEN, "Wrong ephemeral bridge token"
                    assert frame["op"] == expected_operation, frame
                    for key, value in expected_fields.items():
                        assert frame[key] == value, (key, frame)
                    encoded = json.dumps(result, ensure_ascii=True).encode("utf-8")
                    connection.sendall(struct.pack(">I", len(encoded)) + encoded)
                encoded_answer = replies.get(timeout=12)
                if encoded_answer is None:
                    raise RuntimeError("MCP child terminated before tool response")
                answer = json.loads(encoded_answer.decode("utf-8"))
                assert answer["id"] == identifier, answer
                assert answer.get("jsonrpc") == "2.0", answer
                return answer["result"]

            call.counter = 1

            output = call(
                "remote_exec", {"command": "printf test"},
                "exec", {"command": "printf test"},
                {"ok": True, "result": {
                    "stdout": "remote-ok\n", "stderr": "", "exitCode": 0, "truncated": False,
                }},
            )
            execution = json.loads(output["content"][0]["text"])
            assert execution["stdout"] == "remote-ok\n", execution

            files = call(
                "remote_list", {"path": "/tmp"},
                "list", {"path": "/tmp"},
                {"ok": True, "result": [{"name": "тест.txt", "isDirectory": False}]},
            )
            assert json.loads(files["content"][0]["text"])[0]["name"] == "тест.txt"

            original = "one\nдва\n"
            read = call(
                "remote_read", {"path": "/tmp/test.txt"},
                "read", {"path": "/tmp/test.txt"},
                {"ok": True, "result": original},
            )
            assert read["content"][0]["text"] == original, read

            written = call(
                "remote_write", {"path": "/tmp/test.txt", "content": original},
                "write", {"path": "/tmp/test.txt", "content": original},
                {"ok": True, "result": {"written": True}},
            )
            assert json.loads(written["content"][0]["text"])["written"] is True

            denied = call(
                "remote_exec", {"command": "echo not-run"},
                "exec", {"command": "echo not-run"},
                {"ok": False, "error": "SSH session closed by test broker"},
            )
            assert denied["isError"] is True, denied
            assert "SSH session closed" in denied["content"][0]["text"]
            print("PASS: Windows native stdio MCP -> authenticated loopback frames: exec/list/read/write and error propagation.")
        finally:
            try:
                process.stdin.close()
            except (OSError, AttributeError):
                pass
            try:
                process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=4)


if __name__ == "__main__":
    run()
