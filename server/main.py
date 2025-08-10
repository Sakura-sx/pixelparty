#!/usr/bin/env python

import asyncio
import json
from typing import List, Set

from websockets.asyncio.server import serve, WebSocketServerProtocol


# Canvas configuration
CANVAS_WIDTH = 512
CANVAS_HEIGHT = 512

# In-memory 512 x 512 RGB canvas (row-major: canvas[y][x] -> [r, g, b])
canvas: List[List[List[int]]] = [
    [[0, 0, 0] for _ in range(CANVAS_WIDTH)] for _ in range(CANVAS_HEIGHT)
]

# Connected websocket clients for broadcasting updates
connected_clients: Set[WebSocketServerProtocol] = set()

# Lock to protect concurrent updates to canvas state
canvas_lock = asyncio.Lock()


def _validate_color(color: List[int]) -> bool:
    if not isinstance(color, list) or len(color) != 3:
        return False
    return all(isinstance(c, int) and 0 <= c <= 255 for c in color)


def _in_bounds(x: int, y: int) -> bool:
    return 0 <= x < CANVAS_WIDTH and 0 <= y < CANVAS_HEIGHT


async def broadcast_json(message_obj: dict) -> None:
    if not connected_clients:
        return
    message_text = json.dumps(message_obj, separators=(",", ":"))
    # Send to all clients concurrently; drop any that error out
    send_coroutines = []
    for client in list(connected_clients):
        send_coroutines.append(_safe_send(client, message_text))
    await asyncio.gather(*send_coroutines, return_exceptions=True)


async def _safe_send(client: WebSocketServerProtocol, message_text: str) -> None:
    try:
        await client.send(message_text)
    except Exception:
        # Remove dead client on any send error
        connected_clients.discard(client)


async def handle_connection(websocket: WebSocketServerProtocol) -> None:
    connected_clients.add(websocket)
    try:
        # Send basic hello/metadata so clients know canvas size
        await websocket.send(
            json.dumps(
                {
                    "type": "hello",
                    "width": CANVAS_WIDTH,
                    "height": CANVAS_HEIGHT,
                },
                separators=(",", ":"),
            )
        )

        async for raw_message in websocket:
            # Support plain ping string for backward compatibility
            if raw_message == "ping":
                await websocket.send(json.dumps({"type": "pong"}))
                continue

            # Parse JSON protocol
            try:
                message = json.loads(raw_message)
            except json.JSONDecodeError:
                await websocket.send(
                    json.dumps(
                        {"type": "error", "error": "invalid_json", "message": "Message must be JSON"}
                    )
                )
                continue

            msg_type = message.get("type")

            if msg_type == "ping":
                await websocket.send(json.dumps({"type": "pong"}, separators=(",", ":")))

            elif msg_type == "set_pixel":
                x = message.get("x")
                y = message.get("y")
                color = message.get("color")

                if not isinstance(x, int) or not isinstance(y, int) or not _validate_color(color):
                    await websocket.send(
                        json.dumps(
                            {
                                "type": "error",
                                "error": "invalid_arguments",
                                "message": "Expected: {type:'set_pixel', x:int, y:int, color:[r,g,b]} where 0-255",
                            },
                            separators=(",", ":"),
                        )
                    )
                    continue

                if not _in_bounds(x, y):
                    await websocket.send(
                        json.dumps(
                            {
                                "type": "error",
                                "error": "out_of_bounds",
                                "message": f"Pixel ({x},{y}) outside canvas {CANVAS_WIDTH}x{CANVAS_HEIGHT}",
                            },
                            separators=(",", ":"),
                        )
                    )
                    continue

                async with canvas_lock:
                    canvas[y][x] = [int(color[0]), int(color[1]), int(color[2])]

                # Broadcast the update (including to the sender)
                await broadcast_json(
                    {"type": "pixel_update", "x": x, "y": y, "color": canvas[y][x]}
                )

            elif msg_type == "get_canvas":
                # Send a full canvas snapshot
                async with canvas_lock:
                    snapshot = {
                        "type": "canvas",
                        "width": CANVAS_WIDTH,
                        "height": CANVAS_HEIGHT,
                        "data": canvas,
                    }
                await websocket.send(json.dumps(snapshot))

            else:
                await websocket.send(
                    json.dumps(
                        {"type": "error", "error": "unknown_type", "message": f"Unknown type: {msg_type}"},
                        separators=(",", ":"),
                    )
                )

    finally:
        connected_clients.discard(websocket)


async def main() -> None:
    async with serve(handle_connection, "localhost", 8765) as server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())