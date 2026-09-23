"""Tests for uno_app.py against a fake App API (http.server)."""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import uno_app  # noqa: E402

TOKEN = "uno_app_test"
SEEN = []
FILES = {}
STATE = {"polls": 0}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _sse(self, chunks):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for c in chunks:
            self.wfile.write(c if isinstance(c, bytes) else c.encode())
            self.wfile.flush()
            time.sleep(0.005)
        self.close_connection = True

    def _handle(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        SEEN.append({"method": self.command, "path": self.path, "auth": self.headers.get("Authorization"),
                     "ctype": self.headers.get("Content-Type", ""), "body": body})
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return self._send(401, {"error": {"type": "auth", "code": "invalid_app_token", "message": "bad token"}})
        path = self.path.split("?")[0]
        if path == "/v1/chat/completions":
            j = json.loads(body)
            if j["messages"][0]["content"] == "over":
                return self._send(402, {"error": {"type": "limit", "code": "app_limit_reached",
                                                  "message": "This app spent its limit"}})
            if j["messages"][0]["content"] == "gw":  # gateway shape: code in "type"
                return self._send(402, {"error": {"type": "key_limit_reached", "code": 402, "message": "key limit"}})
            if j.get("stream"):
                e1 = ("data: " + json.dumps({"choices": [{"delta": {"content": "Привет"}}]}) + "\n\n").encode()
                e2 = ("data: " + json.dumps({"choices": [{"delta": {"content": ", мир"}}]}, ensure_ascii=False)
                      + "\r\n\r\n").encode()
                return self._sse([e1[:10], e1[10:31], e1[31:] + e2[:3], e2[3:], b": ping\n\n",
                                  b"data: [DO", b"NE]\n\n",
                                  b'data: {"choices":[{"delta":{"content":"never"}}]}\n\n'])
            return self._send(200, {"choices": [{"message": {"role": "assistant", "content": "echo:" + j["model"]}}]})
        if path == "/v1/audio/transcriptions":
            return self._send(200, {"text": "hello from audio"})
        if path == "/v1/whoami":
            return self._send(200, {"app": {"id": "t", "name": "T"}})
        if path == "/v1/tasks" and self.command == "POST":
            STATE["polls"] = 0
            return self._send(202, {"id": "task_1", "threadId": "th_1", "status": "running",
                                    "tools": "edit", "harness": "uno"})
        if path == "/v1/tasks/task_1":
            STATE["polls"] += 1
            p = STATE["polls"]
            status = "running" if p == 1 else "waiting" if p == 2 else "done"
            return self._send(200, {"id": "task_1", "threadId": "th_1", "status": status,
                                    "result": {"text": "all done"} if status == "done" else None,
                                    "waitingFor": "approval" if status == "waiting" else None})
        if path == "/v1/tasks/task_1/events":
            return self._sse(['event: status\ndata: {"status":"running"}\n\n',
                              'event: message\ndata: {"delta":"Reading 4 ',
                              'files"}\n\nevent: activity\ndata: {"kind":"tool","summary":"Read a"}\n\n',
                              'event: done\ndata: {"status":"done","result":{"text":"ok"}}\n\n',
                              'event: status\ndata: {"status":"after"}\n\n'])
        if path == "/v1/tasks/task_1/stop":
            return self._send(200, {"id": "task_1", "status": "stopped"})
        if path.startswith("/v1/storage/files/"):
            key = urllib.parse.unquote(path[len("/v1/storage/files/"):])
            if self.command == "PUT":
                FILES[key] = (body, self.headers.get("Content-Type", ""))
                return self._send(201, {"key": key, "size": len(body)})
            if self.command in ("GET", "HEAD"):
                if key not in FILES:
                    return self._send(404, {"error": {"type": "file_not_found", "code": "file_not_found",
                                                      "message": "No such file"}})
                data, ctype = FILES[key]
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if self.command == "GET":
                    self.wfile.write(data)
                return None
            if self.command == "DELETE":
                return self._send(200, {"deleted": 1 if FILES.pop(key, None) is not None else 0})
        if path == "/v1/storage/list":
            return self._send(200, {"prefix": "", "folders": [], "files": [
                {"key": k, "name": k, "size": len(v[0]), "modifiedAt": None} for k, v in FILES.items()],
                "truncated": False})
        if path == "/v1/storage/url":
            return self._send(200, {"url": "https://s3.example/x?sig=1", "key": json.loads(body)["key"]})
        if path == "/v1/storage":
            return self._send(200, {"usedBytes": sum(len(v[0]) for v in FILES.values()), "limitBytes": 100})
        return self._send(404, {"error": {"type": "nf", "code": "not_found", "message": "nope"}})

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = _handle


ENV = ("UNO_APP_API_URL", "UNO_APP_TOKEN", "UNO_APP_KEY_DIR", "UNO_APP_ID")


class UnoAppTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ENV}
        for k in ENV:
            os.environ.pop(k, None)
        self.c = uno_app.Client(url=self.url, token=TOKEN)

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_storage(self):
        st = self.c.storage
        self.assertEqual(st.put("notes/Заметка 1.md", "# hi"), {"key": "notes/Заметка 1.md", "size": 4})
        self.assertEqual(SEEN[-1]["path"], "/v1/storage/files/notes/%D0%97%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0%201.md")
        self.assertEqual(SEEN[-1]["ctype"], "text/markdown; charset=utf-8")
        self.assertEqual(st.get_text("notes/Заметка 1.md"), "# hi")
        st.put_json("data.json", {"a": 1})
        self.assertEqual(st.get_json("data.json"), {"a": 1})
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "cat.jpg")
            with open(src, "wb") as fh:
                fh.write(b"\xff\xd8jpeg")
            self.assertEqual(st.upload(src, "photos/cat.jpg")["size"], 6)
            self.assertEqual(SEEN[-1]["ctype"], "image/jpeg")
            out = st.download("photos/cat.jpg", os.path.join(d, "back.jpg"))
            with open(out, "rb") as fh:
                self.assertEqual(fh.read(), b"\xff\xd8jpeg")
        self.assertTrue(st.exists("photos/cat.jpg"))
        self.assertFalse(st.exists("photos/dog.jpg"))
        self.assertIn("photos/cat.jpg", [f["key"] for f in st.list()["files"]])
        self.assertTrue(st.url("photos/cat.jpg").startswith("https://"))
        self.assertEqual(st.delete("photos/cat.jpg"), {"deleted": 1})
        with self.assertRaises(uno_app.UnoAppError) as cm:
            st.get("photos/cat.jpg")
        self.assertEqual(cm.exception.code, "file_not_found")
        with self.assertRaises(uno_app.UnoAppError) as cm:
            st.get("../other/secret.txt")
        self.assertEqual((cm.exception.status, cm.exception.code), (400, "invalid_key"))

    def test_ask(self):
        self.assertEqual(self.c.ask("hi", system="brief", max_tokens=20, temperature=0), "echo:default")
        self.assertEqual(SEEN[-1]["auth"], f"Bearer {TOKEN}")
        self.assertEqual(json.loads(SEEN[-1]["body"]), {
            "model": "default", "messages": [{"role": "system", "content": "brief"},
                                             {"role": "user", "content": "hi"}],
            "temperature": 0, "max_tokens": 20})
        self.assertEqual(self.c.ask([{"role": "user", "content": "x"}], model="m/1"), "echo:m/1")

    def test_stream(self):
        self.assertEqual(list(self.c.stream("tell")), ["Привет", ", мир"])
        self.assertTrue(json.loads(SEEN[-1]["body"])["stream"])

    def test_error_402(self):
        with self.assertRaises(uno_app.UnoAppError) as cm:
            self.c.ask("over")
        e = cm.exception
        self.assertEqual((e.status, e.code, e.message), (402, "app_limit_reached", "This app spent its limit"))

    def test_error_gateway_shape(self):
        with self.assertRaises(uno_app.UnoAppError) as cm:
            self.c.ask("gw")
        self.assertEqual((cm.exception.status, cm.exception.code), (402, "key_limit_reached"))

    def test_error_401(self):
        with self.assertRaises(uno_app.UnoAppError) as cm:
            uno_app.Client(url=self.url, token="wrong").whoami()
        self.assertEqual((cm.exception.status, cm.exception.code), (401, "invalid_app_token"))

    def test_unreachable(self):
        with self.assertRaises(uno_app.UnoAppError) as cm:
            uno_app.Client(url="http://127.0.0.1:1", token=TOKEN, timeout=2).whoami()
        self.assertEqual(cm.exception.code, "unreachable")

    def test_transcribe(self):
        self.assertEqual(self.c.transcribe(b"\x01\x02", filename="a.ogg", language="en"), "hello from audio")
        req = SEEN[-1]
        self.assertTrue(req["ctype"].startswith("multipart/form-data; boundary="))
        self.assertIn(b'filename="a.ogg"', req["body"])
        self.assertIn(b'name="language"\r\n\r\nen\r\n', req["body"])
        self.assertIn(b"\x01\x02", req["body"])
        self.assertNotIn(b'name="model"', req["body"])

    def test_task_wait_through_waiting(self):
        t = self.c.task("sum up", cwd="~/Inbox", tools="edit")
        self.assertEqual((t.id, t.thread_id, t.status, t.harness), ("task_1", "th_1", "running", "uno"))
        self.assertEqual(json.loads(SEEN[-1]["body"]), {"prompt": "sum up", "cwd": "~/Inbox", "tools": "edit"})
        done = t.wait()
        self.assertEqual(done["status"], "done")
        self.assertEqual(t.result, {"text": "all done"})
        self.assertEqual(SEEN[-1]["path"], "/v1/tasks/task_1?waitMs=30000")

    def test_task_wait_until_done_false(self):
        t = self.c.task("x")
        self.assertEqual(t.wait(until_done=False)["status"], "waiting")

    def test_task_events_and_stop(self):
        t = self.c.task("x")
        evs = list(t.events())
        self.assertEqual([e["event"] for e in evs], ["status", "message", "activity", "done"])
        self.assertEqual(evs[1]["data"], {"delta": "Reading 4 files"})
        t.stop()
        self.assertEqual(t.status, "stopped")

    def test_config_env(self):
        os.environ["UNO_APP_API_URL"] = self.url + "/"
        os.environ["UNO_APP_TOKEN"] = TOKEN
        c = uno_app.Client()
        self.assertEqual(c.config, {"url": self.url, "token": TOKEN, "app_id": "", "source": "env"})
        self.assertEqual(c.whoami()["app"]["id"], "t")

    def test_config_key_dir(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        with open(os.path.join(d, "api.json"), "w") as fh:
            json.dump({"appId": "notes", "url": self.url, "dockerUrl": "http://host.docker.internal:3779"}, fh)
        with open(os.path.join(d, "token"), "w") as fh:
            fh.write(TOKEN + "\n")
        os.environ["UNO_APP_KEY_DIR"] = d
        cfg = uno_app.Client().config
        self.assertEqual((cfg["token"], cfg["app_id"], cfg["source"]), (TOKEN, "notes", d))
        if not os.path.exists("/.dockerenv"):
            self.assertEqual(cfg["url"], self.url)

    def test_config_waits_then_clear_error(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        os.environ["UNO_APP_KEY_DIR"] = d

        def later():
            time.sleep(0.3)
            with open(os.path.join(d, "token"), "w") as fh:
                fh.write(TOKEN)
        threading.Thread(target=later).start()
        self.assertEqual(uno_app.resolve_config(wait=3)["token"], TOKEN)
        os.remove(os.path.join(d, "token"))
        with self.assertRaises(uno_app.UnoAppError) as cm:
            uno_app.resolve_config(app_id="myapp", wait=0.2)
        self.assertEqual(str(cm.exception),
                         'No Uno app token. Add "ai": {"chat": true} and/or "storage": true to ~/.uno/apps/myapp.json')
        self.assertIsNone(uno_app.find_config(app_id="myapp"))


if __name__ == "__main__":
    unittest.main()
