from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from .workspace_patch import WorkspaceToolError, target_path

# Bound both the compressed input and the decoded image before handing it to Pillow.
_MAX_INPUT_BYTES = 32 * 1024 * 1024
_MAX_IMAGE_PIXELS = 40_000_000
_IMAGE_MIMES = {
    "PNG": "image/png",
    "JPEG": "image/jpeg",
    "GIF": "image/gif",
    "WEBP": "image/webp",
}


@dataclass(frozen=True)
class WorkspaceImage:
    path: str
    data: bytes
    mime_type: str
    width: int
    height: int
    resized: bool
    original: dict[str, int | str]
    warnings: list[str]


def read_workspace_image(
    root: Path,
    path: str,
    *,
    max_bytes: int = 5_242_880,
    max_width: int = 2000,
    max_height: int = 2000,
    auto_resize: bool = True,
) -> WorkspaceImage:
    """Read a workspace-relative image for Base64 data URL transport."""
    resolved = target_path(root, path)
    if not resolved.is_file():
        raise WorkspaceToolError("WORKSPACE_FILE_NOT_FOUND", f"Image file not found: {path}")

    try:
        with resolved.open("rb") as stream:
            data = stream.read(_MAX_INPUT_BYTES + 1)
    except OSError as exc:
        raise WorkspaceToolError("IMAGE_READ_FAILED", f"Could not read image: {path}") from exc
    if len(data) > _MAX_INPUT_BYTES:
        raise WorkspaceToolError(
            "IMAGE_INPUT_TOO_LARGE",
            f"Image input exceeds {_MAX_INPUT_BYTES} bytes.",
        )

    try:
        with Image.open(BytesIO(data)) as image:
            mime_type = _IMAGE_MIMES.get(image.format or "")
            if mime_type is None:
                raise WorkspaceToolError(
                    "BINARY_FILE", "Only PNG, JPEG, GIF, and WebP images are supported."
                )
            width, height = image.size
            if width * height > _MAX_IMAGE_PIXELS:
                raise WorkspaceToolError("IMAGE_TOO_LARGE", "Image pixel count is too large.")

            # Validate the actual image payload, not just its filename or header.
            image.load()
            original: dict[str, int | str] = {
                "bytes": len(data),
                "width": width,
                "height": height,
                "mime_type": mime_type,
            }
            resized = False
            warnings: list[str] = []
            needs_resize = (
                len(data) > max_bytes or width > max_width or height > max_height
            )
            if auto_resize and needs_resize:
                thumbnail = ImageOps.exif_transpose(image)
                thumbnail.thumbnail((max_width, max_height), Image.Resampling.LANCZOS)
                data, mime_type, warnings, (width, height) = _encode_thumbnail(
                    thumbnail, mime_type, max_bytes
                )
                resized = True
                if mime_type == "image/jpeg" and original["mime_type"] == "image/gif":
                    warnings.append("Resized GIF is returned as a single JPEG frame.")
    except WorkspaceToolError:
        raise
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise WorkspaceToolError("BINARY_FILE", "File is not a readable supported image.") from exc

    if len(data) > max_bytes:
        raise WorkspaceToolError(
            "OUTPUT_TOO_LARGE",
            f"Image exceeds max_bytes ({max_bytes}); try auto_resize=true.",
        )

    return WorkspaceImage(
        path=path,
        data=data,
        mime_type=mime_type,
        width=width,
        height=height,
        resized=resized,
        original=original,
        warnings=warnings,
    )


def _encode_thumbnail(
    image: Image.Image, original_mime: str, max_bytes: int
) -> tuple[bytes, str, list[str], tuple[int, int]]:
    warnings: list[str] = []

    # Preserve PNG transparency when it still fits the output budget.
    if original_mime == "image/png":
        output = BytesIO()
        image.save(output, format="PNG", optimize=True)
        if output.tell() <= max_bytes:
            return output.getvalue(), "image/png", warnings, image.size

    if original_mime == "image/png" and ("A" in image.getbands() or "transparency" in image.info):
        warnings.append("PNG transparency was flattened onto white for JPEG size reduction.")

    if image.mode not in {"RGB", "L"}:
        rgba = image.convert("RGBA")
        rgb = Image.new("RGB", image.size, (255, 255, 255))
        rgb.paste(rgba, mask=rgba.getchannel("A"))
        image = rgb

    # Like coding-tools-mcp: attempt progressively lower JPEG quality. Further
    # reduce dimensions if the image is still too large at the lowest quality.
    for _ in range(8):
        for quality in (85, 70, 55, 40):
            output = BytesIO()
            image.save(output, format="JPEG", quality=quality, optimize=True)
            if output.tell() <= max_bytes:
                return output.getvalue(), "image/jpeg", warnings, image.size
        if image.width == 1 and image.height == 1:
            break
        next_size = (
            max(1, int(image.width * 0.8)),
            max(1, int(image.height * 0.8)),
        )
        image = image.copy()
        image.thumbnail(next_size, Image.Resampling.LANCZOS)

    raise WorkspaceToolError("OUTPUT_TOO_LARGE", "Image cannot fit within max_bytes.")
