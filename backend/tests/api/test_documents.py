from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from fieldmerge.config import Settings
from fieldmerge.main import create_app

DOCUMENT_ID = "inspection-pump-07"


def configured_client(tmp_path: Path, **overrides: object) -> TestClient:
    database = tmp_path / "configured-fieldmerge-tests.db"
    return TestClient(
        create_app(
            Settings(
                database_url=f"sqlite+aiosqlite:///{database.as_posix()}",
                auto_create_schema=True,
                cors_origins=["https://fieldmerge.example.com"],
                **overrides,
            )
        )
    )


def pending(
    actor: str,
    value: str,
    *,
    counter: int = 1,
    context: dict[str, int] | None = None,
    field: str = "observation",
    kind: str = "set",
    operation_id: UUID | None = None,
) -> dict[str, Any]:
    return {
        "operation_id": str(operation_id or uuid4()),
        "actor_id": actor,
        "actor_counter": counter,
        "context": context or {"baseline": 4},
        "field": field,
        "kind": kind,
        "value": value,
        "created_at": datetime(2026, 8, 28, 15, 0, tzinfo=UTC).isoformat(),
    }


def sync(client: TestClient, operations: list[dict[str, Any]], known: dict[str, int] | None = None):  # type: ignore[no-untyped-def]
    return client.post(
        f"/api/v1/documents/{DOCUMENT_ID}/sync",
        json={
            "client_id": "test-client",
            "known_vector": known or {},
            "pending_operations": operations,
        },
    )


def test_health_and_seeded_document(client: TestClient) -> None:
    assert client.get("/health/live").json()["status"] == "ok"
    assert client.get("/health/ready").json()["status"] == "ok"

    response = client.get(f"/api/v1/documents/{DOCUMENT_ID}")

    assert response.status_code == 200
    body = response.json()
    assert body["state"] == {
        "site_name": "North Pump Station",
        "priority": "High",
        "status": "Inspection in progress",
        "observation": "Seal is stable; monitor vibration.",
    }
    assert body["version_vector"] == {"baseline": 4}
    assert len(body["state_digest"]) == 64


def test_reverse_reconnect_order_produces_same_conflict_and_digest(client: TestClient) -> None:
    north = pending("tablet-north", "Seal leak is increasing.")
    south = pending("tablet-south", "Vibration is above the normal range.")

    sync(client, [south])
    first_order = sync(client, [north])
    assert first_order.status_code == 200
    first = first_order.json()

    client.post("/api/v1/demo/reset")
    sync(client, [north])
    reverse_order = sync(client, [south])
    assert reverse_order.status_code == 200
    second = reverse_order.json()

    assert first["state_digest"] == second["state_digest"]
    assert first["state"] == second["state"]
    assert first["state"]["observation"] is None
    assert {candidate["value"] for candidate in first["conflicts"][0]["candidates"]} == {
        "Seal leak is increasing.",
        "Vibration is above the normal range.",
    }


def test_idempotent_replay_is_reported_without_new_operation(client: TestClient) -> None:
    operation = pending("tablet-north", "Seal leak is increasing.")
    first = sync(client, [operation])
    second = sync(client, [operation])

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["accepted_operation_ids"] == []
    assert second.json()["duplicate_operation_ids"] == [operation["operation_id"]]
    log = client.get(f"/api/v1/documents/{DOCUMENT_ID}/operations").json()
    assert log["count"] == 5


def test_operation_id_cannot_be_reused_with_different_content(client: TestClient) -> None:
    operation_id = uuid4()
    original = pending("tablet-north", "first", operation_id=operation_id)
    changed = pending("tablet-north", "changed", operation_id=operation_id)

    assert sync(client, [original]).status_code == 200
    response = sync(client, [changed])

    assert response.status_code == 409
    assert "reused with different content" in response.json()["detail"]


def test_operation_dot_cannot_belong_to_two_ids(client: TestClient) -> None:
    assert sync(client, [pending("tablet-north", "first")]).status_code == 200

    response = sync(client, [pending("tablet-north", "second")])

    assert response.status_code == 409
    assert "operation dot" in response.json()["detail"]


def test_resolution_requires_and_then_covers_every_candidate(client: TestClient) -> None:
    sync(client, [pending("tablet-north", "north")])
    sync(client, [pending("tablet-south", "south")])
    incomplete = pending(
        "supervisor",
        "combined",
        kind="resolve",
        context={"baseline": 4, "tablet-north": 1},
    )

    rejected = sync(client, [incomplete])
    assert rejected.status_code == 422
    assert "every current observation candidate" in rejected.json()["detail"]

    complete = pending(
        "supervisor",
        "North and south observations confirmed.",
        kind="resolve",
        context={"baseline": 4, "tablet-north": 1, "tablet-south": 1},
    )
    resolved = sync(client, [complete])

    assert resolved.status_code == 200
    assert resolved.json()["conflicts"] == []
    assert resolved.json()["state"]["observation"] == "North and south observations confirmed."


def test_incremental_sync_returns_only_unseen_actor_dots(client: TestClient) -> None:
    north = pending("tablet-north", "north")
    south = pending("tablet-south", "south")
    sync(client, [north])
    sync(client, [south])

    response = sync(client, [], known={"baseline": 4, "tablet-north": 1})

    assert response.status_code == 200
    body = response.json()
    assert body["sync_mode"] == "incremental"
    assert [item["actor_id"] for item in body["operations"]] == ["tablet-south"]


def test_compacted_client_receives_snapshot_catch_up(client: TestClient) -> None:
    sync(client, [pending("tablet-north", "north")])
    compact = client.post(f"/api/v1/documents/{DOCUMENT_ID}/compact")
    assert compact.status_code == 200
    assert compact.json()["retained_audit_operations"] == 5

    response = sync(client, [], known={})

    assert response.status_code == 200
    body = response.json()
    assert body["sync_mode"] == "snapshot"
    assert body["snapshot"]["version_vector"] == {
        "baseline": 4,
        "tablet-north": 1,
    }
    assert body["operations"] == []


def test_websocket_emits_only_committed_backend_state(client: TestClient) -> None:
    with client.websocket_connect(f"/api/v1/documents/{DOCUMENT_ID}/stream") as websocket:
        initial = websocket.receive_json()
        assert initial["type"] == "document.committed"
        assert initial["document"]["version_vector"] == {"baseline": 4}

        response = sync(client, [pending("tablet-north", "streamed")])
        assert response.status_code == 200
        committed = websocket.receive_json()

    assert committed["document"]["state_digest"] == response.json()["state_digest"]
    assert committed["document"]["server_sequence"] == response.json()["server_sequence"]


def test_unknown_document_without_pending_operations_is_not_created(client: TestClient) -> None:
    response = client.post(
        "/api/v1/documents/unknown/sync",
        json={"client_id": "tablet-north", "known_vector": {}, "pending_operations": []},
    )

    assert response.status_code == 404


def test_local_mode_still_allows_a_new_document_with_an_operation(client: TestClient) -> None:
    response = client.post(
        "/api/v1/documents/local-inspection/sync",
        json={
            "client_id": "tablet-north",
            "known_vector": {},
            "pending_operations": [pending("tablet-north", "Local-only report")],
        },
    )

    assert response.status_code == 200
    assert response.json()["document_id"] == "local-inspection"


def test_public_demo_mode_rejects_arbitrary_document_creation(tmp_path: Path) -> None:
    with configured_client(tmp_path, public_demo_mode=True) as client:
        response = client.post(
            "/api/v1/documents/attacker-chosen-id/sync",
            json={
                "client_id": "unknown-client",
                "known_vector": {},
                "pending_operations": [pending("unknown-client", "Do not store this")],
            },
        )
        missing = client.get("/api/v1/documents/attacker-chosen-id")
        operation_log = client.get("/api/v1/documents/attacker-chosen-id/operations")
        compact = client.post("/api/v1/documents/attacker-chosen-id/compact")

    assert response.status_code == 404
    assert missing.status_code == 404
    assert operation_log.status_code == 404
    assert compact.status_code == 404


def test_operation_log_limit_rejects_only_new_operations(tmp_path: Path) -> None:
    operation = pending("tablet-north", "Fifth stored operation")
    with configured_client(tmp_path, max_log_operations=5) as client:
        accepted = sync(client, [operation])
        replayed = sync(client, [operation])
        rejected = sync(client, [pending("tablet-south", "Would be number six")])
        operation_log = client.get(f"/api/v1/documents/{DOCUMENT_ID}/operations")

    assert accepted.status_code == 200
    assert replayed.status_code == 200
    assert replayed.json()["duplicate_operation_ids"] == [operation["operation_id"]]
    assert rejected.status_code == 413
    assert "configured limit" in rejected.json()["detail"]
    assert operation_log.json()["count"] == 5


def test_public_demo_websocket_requires_an_allowed_origin(tmp_path: Path) -> None:
    with configured_client(tmp_path, public_demo_mode=True) as client:
        with (
            pytest.raises(WebSocketDisconnect) as denied,
            client.websocket_connect(
                f"/api/v1/documents/{DOCUMENT_ID}/stream",
                headers={"origin": "https://untrusted.example.com"},
            ),
        ):
            pass

        with client.websocket_connect(
            f"/api/v1/documents/{DOCUMENT_ID}/stream",
            headers={"origin": "https://fieldmerge.example.com"},
        ) as websocket:
            initial = websocket.receive_json()

    assert denied.value.code == 1008
    assert initial["document"]["document_id"] == DOCUMENT_ID


def test_resolve_kind_is_rejected_for_scalar_fields(client: TestClient) -> None:
    operation = pending(
        "tablet-north",
        "Urgent",
        field="priority",
        kind="resolve",
    )

    response = sync(client, [operation])

    assert response.status_code == 422
