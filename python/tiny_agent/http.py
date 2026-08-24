import asyncio
import re
import time

MAX_HTTP_HEADER_BYTES = 64 * 1024


def remaining(deadline: float) -> float:
    value = deadline - time.monotonic()
    if value <= 0: raise asyncio.TimeoutError
    return value


class FramedHttpBody:
    def __init__(
        self,
        reader: asyncio.StreamReader,
        deadline: float,
        max_body_bytes: int,
        invalid_message: str,
        too_large_message: str,
        framing: str,
        content_length: int | None,
        header_bytes: int,
    ):
        self.reader, self.deadline, self.max_body_bytes = reader, deadline, max_body_bytes
        self.invalid_message, self.too_large_message = invalid_message, too_large_message
        self.framing, self.content_length, self.header_bytes = framing, content_length, header_bytes
        self.decoded_bytes, self.finished = 0, False

    def __aiter__(self):
        return self

    async def __anext__(self) -> bytes:
        if self.finished: raise StopAsyncIteration
        if self.framing == "chunked": return await self._read_chunk()
        if self.framing == "content-length":
            self.finished = True
            length = self.content_length or 0
            if not length: raise StopAsyncIteration
            self.decoded_bytes = length
            return await self._read_exactly(length)

        chunk = await asyncio.wait_for(
            self.reader.read(min(65_536, self.max_body_bytes + 1 - self.decoded_bytes)),
            remaining(self.deadline),
        )
        if not chunk:
            self.finished = True
            raise StopAsyncIteration
        self.decoded_bytes += len(chunk)
        if self.decoded_bytes > self.max_body_bytes: raise RuntimeError(self.too_large_message)
        return chunk

    async def read(self) -> bytes:
        body = bytearray()
        async for chunk in self: body.extend(chunk)
        return bytes(body)

    async def _read_line(self) -> bytes:
        try:
            line = await asyncio.wait_for(self.reader.readline(), remaining(self.deadline))
        except (asyncio.LimitOverrunError, ValueError):
            raise RuntimeError(self.invalid_message) from None
        self.header_bytes += len(line)
        if not line or self.header_bytes > MAX_HTTP_HEADER_BYTES or not line.endswith(b"\r\n"):
            raise RuntimeError(self.invalid_message)
        return line

    async def _read_exactly(self, size: int) -> bytes:
        try: return await asyncio.wait_for(self.reader.readexactly(size), remaining(self.deadline))
        except asyncio.IncompleteReadError: raise RuntimeError(self.invalid_message) from None

    async def _read_chunk(self) -> bytes:
        line = await self._read_line()
        size_text = line[:-2].split(b";", 1)[0].strip()
        if not size_text or not re.fullmatch(rb"[0-9A-Fa-f]+", size_text): raise RuntimeError(self.invalid_message)
        size = int(size_text, 16)
        if size > self.max_body_bytes - self.decoded_bytes: raise RuntimeError(self.too_large_message)
        if size:
            chunk = await self._read_exactly(size)
            if await self._read_exactly(2) != b"\r\n":
                raise RuntimeError(self.invalid_message)
            self.decoded_bytes += size
            return chunk
        while True:
            trailer = await self._read_line()
            if trailer == b"\r\n":
                self.finished = True
                raise StopAsyncIteration
            if trailer[:1] in (b" ", b"\t") or b":" not in trailer: raise RuntimeError(self.invalid_message)


async def read_http_response_headers(
    reader: asyncio.StreamReader,
    deadline: float,
    max_body_bytes: int,
    invalid_message: str,
    too_large_message: str,
) -> tuple[int, dict[str, str], FramedHttpBody]:
    header_bytes = 0

    async def read_line() -> bytes:
        nonlocal header_bytes
        try:
            line = await asyncio.wait_for(reader.readline(), remaining(deadline))
        except (asyncio.LimitOverrunError, ValueError):
            raise RuntimeError(invalid_message) from None
        header_bytes += len(line)
        if not line or header_bytes > MAX_HTTP_HEADER_BYTES or not line.endswith(b"\r\n"):
            raise RuntimeError(invalid_message)
        return line

    status_line = await read_line()
    match = re.fullmatch(rb"HTTP/1\.[01] ([0-9]{3})(?: [^\r\n]*)?\r\n", status_line)
    if not match: raise RuntimeError(invalid_message)
    status = int(match.group(1))
    values: dict[str, list[str]] = {}
    while True:
        line = await read_line()
        if line == b"\r\n": break
        if line[:1] in (b" ", b"\t") or b":" not in line: raise RuntimeError(invalid_message)
        raw_name, raw_value = line[:-2].split(b":", 1)
        try:
            name = raw_name.decode("ascii").lower()
            value = raw_value.decode("iso-8859-1").strip()
        except UnicodeDecodeError:
            raise RuntimeError(invalid_message) from None
        if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name): raise RuntimeError(invalid_message)
        values.setdefault(name, []).append(value)

    content_lengths = values.get("content-length", [])
    transfer_encodings = values.get("transfer-encoding", [])
    if content_lengths and transfer_encodings: raise RuntimeError(invalid_message)
    headers = {name: ", ".join(items) for name, items in values.items()}

    framing = "eof"
    content_length = None
    if transfer_encodings:
        codings = [coding.strip().lower() for value in transfer_encodings for coding in value.split(",")]
        if codings != ["chunked"]: raise RuntimeError(invalid_message)
        framing = "chunked"
    elif content_lengths:
        normalized = [value.strip() for item in content_lengths for value in item.split(",")]
        if not normalized or any(not value.isdigit() for value in normalized) or len(set(normalized)) != 1:
            raise RuntimeError(invalid_message)
        content_length = int(normalized[0])
        if content_length > max_body_bytes: raise RuntimeError(too_large_message)
        framing = "content-length"

    body = FramedHttpBody(
        reader, deadline, max_body_bytes, invalid_message, too_large_message,
        framing, content_length, header_bytes,
    )
    return status, headers, body


async def read_http_response(
    reader: asyncio.StreamReader,
    deadline: float,
    max_body_bytes: int,
    invalid_message: str,
    too_large_message: str,
) -> tuple[int, dict[str, str], bytes]:
    status, headers, body = await read_http_response_headers(
        reader, deadline, max_body_bytes, invalid_message, too_large_message,
    )
    return status, headers, await body.read()


async def wait_owned(awaitable, cancelled: asyncio.Event | None):
    owned = asyncio.create_task(awaitable)
    if cancelled is None:
        return await owned
    cancellation = asyncio.create_task(cancelled.wait())
    try:
        done, _ = await asyncio.wait((owned, cancellation), return_when=asyncio.FIRST_COMPLETED)
        if owned in done: return await owned
        owned.cancel()
        await asyncio.gather(owned, return_exceptions=True)
        raise InterruptedError("Operation aborted")
    except asyncio.CancelledError:
        owned.cancel()
        await asyncio.gather(owned, return_exceptions=True)
        if cancelled.is_set(): raise InterruptedError("Operation aborted") from None
        raise
    finally:
        cancellation.cancel()
        await asyncio.gather(cancellation, return_exceptions=True)


async def close_writer(writer: asyncio.StreamWriter, deadline: float | None = None) -> None:
    writer.close()
    timeout = 1.0 if deadline is None else max(0.01, min(1.0, deadline - time.monotonic()))
    try: await asyncio.wait_for(writer.wait_closed(), timeout)
    except (OSError, asyncio.TimeoutError): pass
