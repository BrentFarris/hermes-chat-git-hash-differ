"""Find references, retaining provenance but never exporting the transcript."""

import json
import re
from urllib.parse import urlsplit

LONG = re.compile(r"(?<![\w])([0-9a-fA-F]{7,64})(?![\w])")
SHORT = re.compile(r"\b(?:commit(?:\s+hash)?|sha(?:-?(?:1|256))?|revision|rev)\s*[:=#]?\s*[`\"']?([0-9a-fA-F]{4,6})(?![\w])", re.I)
GIT_OUTPUT = re.compile(r"\[[^\]\r\n]+\s([0-9a-fA-F]{4,6})\]")
URL = re.compile(r"https?://[^\s<>`\"']+/(?:commit|commits|-/commit)/([0-9a-fA-F]{4,64})(?![\w])", re.I)


def text_parts(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for part in value:
            yield from text_parts(part)
    elif isinstance(value, dict):
        if value.get("type") in {"image", "image_url", "input_image", "audio", "input_audio"}:
            return
        # Structured text/tool payloads only; image URLs and reasoning are not conversation text.
        for key, part in value.items():
            if key not in {"reasoning", "reasoning_content", "image_url", "signature"}:
                yield from text_parts(part)


def references(text):
    matches = {}
    for regex in (LONG, SHORT, GIT_OUTPUT):
        for match in regex.finditer(text):
            matches[(match.start(1), match.end(1))] = {"hash": match[1].lower(), "hint": None}
    for match in URL.finditer(text):
        parsed = urlsplit(match[0])
        prefix = re.split(r"/(?:commit|commits|-/commit)/", parsed.path)[0]
        matches[(match.start(1), match.end(1))] = {
            "hash": match[1].lower(), "hint": f"{parsed.hostname}{prefix}".removesuffix(".git").lower()}
    return [value for _, value in sorted(matches.items())]


def scan_messages(messages):
    found = []
    for position, message in enumerate(messages):
        if message.get("role") not in {"user", "assistant", "tool"}:
            continue
        values = [message.get("content", message.get("text", ""))]
        calls = message.get("tool_calls") or []
        if isinstance(calls, str):
            try:
                calls = json.loads(calls)
            except ValueError:
                calls = []
        for call in calls if isinstance(calls, list) else []:
            if isinstance(call, dict):
                values.append(call.get("function", {}).get("arguments", ""))
        text = "\n".join(part for value in values for part in text_parts(value))
        for reference in references(text):
            found.append({**reference, "position": position,
                          "message_id": str(message.get("id", message.get("_row_id", position)))})
    return found
