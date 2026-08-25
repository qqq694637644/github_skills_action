from __future__ import annotations

import hashlib
import re
from pathlib import Path

from .runtime import env_value_from_environment_or_dotenv
from .workspace_patch import WorkspaceToolError

_WORKSPACE_ID_RE = re.compile(r"^ws_[0-9a-f]{16}$")


class WorkspaceRegistry:
    """Persistent workspace directories addressed by opaque workspace IDs."""

    def storage_root(self) -> Path:
        value = env_value_from_environment_or_dotenv("WORKSPACE_ROOT")
        if not value:
            raise WorkspaceToolError(
                "WORKSPACE_ROOT_NOT_CONFIGURED",
                "WORKSPACE_ROOT is not configured in the environment or .env file.",
                status_code=503,
            )
        root = Path(value).expanduser().resolve()
        if root.exists() and not root.is_dir():
            raise WorkspaceToolError(
                "WORKSPACE_ROOT_INVALID",
                f"WORKSPACE_ROOT is not a directory: {root}",
                status_code=503,
            )
        try:
            root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise WorkspaceToolError(
                "WORKSPACE_ROOT_INVALID",
                f"WORKSPACE_ROOT could not be prepared: {root}: {exc}",
                status_code=503,
            ) from exc
        if not root.is_dir():
            raise WorkspaceToolError(
                "WORKSPACE_ROOT_INVALID",
                f"WORKSPACE_ROOT is not a directory: {root}",
                status_code=503,
            )
        return root

    def prepare(
        self,
        *,
        idempotency_key: str | None,
        workspace_id: str | None,
    ) -> dict[str, object]:
        root = self.storage_root()
        if workspace_id is not None:
            path = self.resolve(workspace_id)
            return {
                "workspace_id": workspace_id,
                "created": False,
                "empty": not any(path.iterdir()),
            }
        if not idempotency_key:
            raise WorkspaceToolError(
                "VALIDATION_ERROR",
                "idempotency_key is required when creating a workspace.",
                status_code=422,
            )
        digest = hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()[:16]
        generated_id = f"ws_{digest}"
        path = root / generated_id
        created = not path.exists()
        path.mkdir(parents=True, exist_ok=True)
        return {"workspace_id": generated_id, "created": created, "empty": not any(path.iterdir())}

    def resolve(self, workspace_id: str) -> Path:
        if not _WORKSPACE_ID_RE.fullmatch(workspace_id):
            raise WorkspaceToolError(
                "WORKSPACE_ID_INVALID",
                "workspace_id must have the form ws_<16 lowercase hex chars>.",
                status_code=422,
            )
        path = self.storage_root() / workspace_id
        if not path.is_dir():
            raise WorkspaceToolError(
                "WORKSPACE_NOT_FOUND",
                f"Workspace was not found: {workspace_id}",
                status_code=404,
            )
        return path
