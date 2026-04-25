import importlib
import os
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parents[1]
LOBSTER_BIN = PROJECT_ROOT / "lobster" / "bin"
sys.path.insert(0, str(LOBSTER_BIN))


@contextmanager
def patched_env(**updates):
    original = os.environ.copy()
    os.environ.clear()
    os.environ.update(original)
    for key, value in updates.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(original)


class OpenClawMediaGatewayTests(unittest.TestCase):
    def test_stage4_image_enablement_allows_gateway_without_gemini_key(self):
        stage4 = importlib.import_module("_stage4_common")
        with patched_env(
            GEMINI_API_KEY=None,
            LOBSTER_MEDIA_GATEWAY_ENABLED="1",
            OPENCLAW_GATEWAY_URL="https://gateway.example.test",
            OPENCLAW_GATEWAY_TOKEN="test-token",
        ):
            self.assertTrue(stage4.nano_banana_enabled())

    def test_stage4_video_enablement_allows_gateway_without_gemini_key(self):
        stage4 = importlib.import_module("_stage4_common")
        with patched_env(
            GEMINI_API_KEY=None,
            LOBSTER_VIDEO_RENDER_ENABLED="1",
            LOBSTER_MEDIA_GATEWAY_ENABLED="1",
            OPENCLAW_GATEWAY_URL="https://gateway.example.test",
            OPENCLAW_GATEWAY_TOKEN="test-token",
        ):
            self.assertTrue(stage4.veo_render_enabled())

    def test_run_nano_banana_uses_gateway_before_direct_gemini(self):
        stage4 = importlib.import_module("_stage4_common")
        with tempfile.TemporaryDirectory() as tempdir:
            destination = Path(tempdir) / "image.png"
            with patched_env(
                GEMINI_API_KEY=None,
                LOBSTER_MEDIA_GATEWAY_ENABLED="1",
                OPENCLAW_GATEWAY_URL="https://gateway.example.test",
                OPENCLAW_GATEWAY_TOKEN="test-token",
            ), mock.patch.object(stage4, "generate_gateway_image") as generate_gateway_image:
                generate_gateway_image.return_value = {"executed": True, "status": "ok", "provider": "openclaw_media_gateway"}
                result = stage4.run_nano_banana("prompt", destination, "4:5")
        self.assertEqual(result["provider"], "openclaw_media_gateway")
        generate_gateway_image.assert_called_once()

    def test_run_veo_render_uses_gateway_before_direct_gemini(self):
        stage4 = importlib.import_module("_stage4_common")
        with tempfile.TemporaryDirectory() as tempdir:
            destination = Path(tempdir) / "video.mp4"
            with patched_env(
                GEMINI_API_KEY=None,
                LOBSTER_VIDEO_RENDER_ENABLED="1",
                LOBSTER_MEDIA_GATEWAY_ENABLED="1",
                OPENCLAW_GATEWAY_URL="https://gateway.example.test",
                OPENCLAW_GATEWAY_TOKEN="test-token",
            ), mock.patch.object(stage4, "generate_gateway_video") as generate_gateway_video:
                generate_gateway_video.return_value = {"executed": True, "status": "ok", "provider": "openclaw_media_gateway"}
                result = stage4.run_veo_render("prompt", destination, "9:16", 8)
        self.assertEqual(result["provider"], "openclaw_media_gateway")
        generate_gateway_video.assert_called_once()
        self.assertIsNone(generate_gateway_video.call_args.kwargs.get("model"))

    def test_gateway_video_model_uses_gateway_specific_override(self):
        stage4 = importlib.import_module("_stage4_common")
        with tempfile.TemporaryDirectory() as tempdir:
            destination = Path(tempdir) / "video.mp4"
            with patched_env(
                GEMINI_API_KEY="***",
                LOBSTER_VIDEO_RENDER_ENABLED="1",
                LOBSTER_MEDIA_GATEWAY_ENABLED="1",
                LOBSTER_GATEWAY_VIDEO_MODEL="openai/sora-2",
                OPENCLAW_GATEWAY_URL="https://gateway.example.test",
                OPENCLAW_GATEWAY_TOKEN="***",
            ), mock.patch.object(stage4, "generate_gateway_video") as generate_gateway_video:
                generate_gateway_video.return_value = {"executed": True, "status": "ok", "provider": "openclaw_media_gateway"}
                stage4.run_veo_render("prompt", destination, "9:16", 8)
        self.assertEqual(generate_gateway_video.call_args.kwargs.get("model"), "openai/sora-2")

    def test_gateway_requested_without_url_token_fails_closed_for_image(self):
        stage4 = importlib.import_module("_stage4_common")
        with tempfile.TemporaryDirectory() as tempdir:
            destination = Path(tempdir) / "image.png"
            with patched_env(
                GEMINI_API_KEY="legacy-direct-key",
                LOBSTER_MEDIA_GATEWAY_ENABLED="1",
                OPENCLAW_GATEWAY_URL=None,
                OPENCLAW_GATEWAY_TOKEN=None,
            ):
                result = stage4.run_nano_banana("prompt", destination, "4:5")
        self.assertFalse(result["executed"])
        self.assertEqual(result["provider"], "openclaw_media_gateway")
        self.assertIn("OPENCLAW_GATEWAY_URL_missing", result["stderr"])
        self.assertFalse(destination.exists())

    def test_gateway_requested_without_url_token_fails_closed_for_video(self):
        stage4 = importlib.import_module("_stage4_common")
        with tempfile.TemporaryDirectory() as tempdir:
            destination = Path(tempdir) / "video.mp4"
            with patched_env(
                GEMINI_API_KEY="legacy-direct-key",
                LOBSTER_VIDEO_RENDER_ENABLED="1",
                LOBSTER_MEDIA_GATEWAY_ENABLED="1",
                OPENCLAW_GATEWAY_URL=None,
                OPENCLAW_GATEWAY_TOKEN=None,
            ):
                with self.assertRaisesRegex(RuntimeError, "media_gateway"):
                    stage4.run_veo_render("prompt", destination, "9:16", 8)
        self.assertFalse(destination.exists())

    def test_gateway_image_text_qa_uses_openclaw_image_tool_without_gemini_key(self):
        stage4 = importlib.import_module("_stage4_common")
        with tempfile.TemporaryDirectory() as tempdir:
            image_path = Path(tempdir) / "image.png"
            image_path.write_bytes(b"\x89PNG\r\n\x1a\nnot-real-but-nonzero")
            with patched_env(
                GEMINI_API_KEY=None,
                LOBSTER_MEDIA_GATEWAY_ENABLED="1",
                OPENCLAW_GATEWAY_URL="https://gateway.example.test",
                OPENCLAW_GATEWAY_TOKEN="test-token",
            ), mock.patch.object(stage4, "invoke_media_tool") as invoke_media_tool:
                invoke_media_tool.return_value = {"content": [{"type": "text", "text": '{"lines":["Launch today"]}'}]}
                lines = stage4.ocr_image_text_with_gemini(image_path)
        self.assertEqual(lines, ["Launch today"])
        invoke_media_tool.assert_called_once()
        self.assertEqual(invoke_media_tool.call_args.args[0], "image")

    def test_redact_sensitive_removes_tokens_keys_urls_and_prompt(self):
        gateway = importlib.import_module("_openclaw_media_gateway")
        with patched_env(
            OPENCLAW_GATEWAY_TOKEN="secret-gateway-token",
            GEMINI_API_KEY="secret-gemini-key",
        ):
            redacted = gateway.redact_sensitive(
                "prompt says launch secret-gateway-token secret-gemini-key "
                "https://cdn.example.test/file.png?X-Goog-Signature=abc&token=secret-gateway-token",
                prompt="prompt says launch",
            )
        self.assertNotIn("secret-gateway-token", redacted)
        self.assertNotIn("secret-gemini-key", redacted)
        self.assertNotIn("prompt says launch", redacted)
        self.assertIn("[REDACTED", redacted)

    def test_copy_gateway_local_media_rejects_paths_outside_allowed_roots(self):
        gateway = importlib.import_module("_openclaw_media_gateway")
        with tempfile.TemporaryDirectory() as allowed, tempfile.TemporaryDirectory() as outside_dir:
            destination = Path(allowed) / "out.png"
            outside = Path(outside_dir) / "outside-secret.png"
            outside.write_bytes(b"\x89PNG\r\n\x1a\nnot-real-but-nonzero")
            with patched_env(LOBSTER_MEDIA_GATEWAY_SHARED_ROOTS=allowed):
                with self.assertRaisesRegex(RuntimeError, "unsafe_media_path"):
                    gateway.copy_gateway_media_to_destination(str(outside), destination, expected_kind="image")
            self.assertFalse(destination.exists())

    def test_copy_gateway_local_media_writes_atomically_and_rejects_zero_byte(self):
        gateway = importlib.import_module("_openclaw_media_gateway")
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            source = root / "zero.png"
            source.write_bytes(b"")
            destination = root / "out.png"
            with patched_env(LOBSTER_MEDIA_GATEWAY_SHARED_ROOTS=tempdir):
                with self.assertRaisesRegex(RuntimeError, "empty_media"):
                    gateway.copy_gateway_media_to_destination(str(source), destination, expected_kind="image")
            self.assertFalse(destination.exists())

    def test_invoke_tool_posts_expected_gateway_payload(self):
        gateway = importlib.import_module("_openclaw_media_gateway")
        captured = {}

        class FakeResponse:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'{"ok":true,"result":{"content":[{"type":"text","text":"MEDIA:/tmp/generated.png"}],"details":{"paths":["/tmp/generated.png"]}}}'

        def fake_urlopen(request, timeout=0):
            captured["url"] = request.full_url
            captured["headers"] = dict(request.header_items())
            captured["body"] = request.data.decode("utf-8")
            captured["timeout"] = timeout
            return FakeResponse()

        with patched_env(
            OPENCLAW_GATEWAY_URL="https://gateway.example.test/",
            OPENCLAW_GATEWAY_TOKEN="secret-gateway-token",
            OPENCLAW_SESSION_KEY="media-session",
        ), mock.patch("urllib.request.urlopen", fake_urlopen):
            result = gateway.invoke_media_tool("image_generate", {"prompt": "sensitive prompt"}, prompt="sensitive prompt")

        self.assertEqual(captured["url"], "https://gateway.example.test/tools/invoke")
        self.assertIn('"tool": "image_generate"', captured["body"])
        self.assertIn('"sessionKey": "media-session"', captured["body"])
        self.assertEqual(result["paths"], ["/tmp/generated.png"])

    def test_gateway_generation_normalizes_human_aspect_aliases(self):
        gateway = importlib.import_module("_openclaw_media_gateway")
        with tempfile.TemporaryDirectory() as tempdir:
            destination = Path(tempdir) / "image.png"
            with mock.patch.object(gateway, "invoke_media_tool") as invoke_media_tool, mock.patch.object(
                gateway, "copy_gateway_media_to_destination"
            ) as copy_gateway_media_to_destination:
                invoke_media_tool.return_value = {"paths": ["/tmp/generated.png"]}
                gateway.generate_image("prompt", destination, aspect_ratio="square")
        invoke_media_tool.assert_called_once()
        args = invoke_media_tool.call_args.args[1]
        self.assertEqual(args["aspect_ratio"], "1:1")
        self.assertEqual(args["aspectRatio"], "1:1")
        copy_gateway_media_to_destination.assert_called_once()

    def test_gateway_image_model_uses_gateway_specific_override(self):
        gateway = importlib.import_module("_openclaw_media_gateway")
        with tempfile.TemporaryDirectory() as tempdir:
            destination = Path(tempdir) / "image.png"
            with patched_env(LOBSTER_GATEWAY_IMAGE_MODEL="openai/gpt-image-2"), mock.patch.object(
                gateway, "invoke_media_tool"
            ) as invoke_media_tool, mock.patch.object(gateway, "copy_gateway_media_to_destination"):
                invoke_media_tool.return_value = {"paths": ["/tmp/generated.png"]}
                gateway.generate_image("prompt", destination, aspect_ratio="4:5")
        self.assertEqual(invoke_media_tool.call_args.args[1]["model"], "openai/gpt-image-2")


if __name__ == "__main__":
    unittest.main()
