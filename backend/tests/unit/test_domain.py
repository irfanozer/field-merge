from datetime import UTC, datetime
from itertools import permutations
from uuid import uuid4

from fieldmerge.domain import (
    DomainOperation,
    happened_before,
    materialize,
    resolution_covers_candidates,
    unresolved_observation_candidates,
)

NOW = datetime(2026, 8, 28, tzinfo=UTC)


def operation(
    actor: str,
    counter: int,
    value: str,
    *,
    field: str = "observation",
    context: dict[str, int] | None = None,
    kind: str = "set",
    operation_id: str | None = None,
) -> DomainOperation:
    return DomainOperation(
        operation_id=operation_id or str(uuid4()),
        actor_id=actor,
        actor_counter=counter,
        context=context or {},
        field=field,
        kind=kind,
        value=value,
        created_at=NOW,
    )


def test_happened_before_uses_causal_context_not_time() -> None:
    first = operation("north", 2, "first")
    second = operation("south", 9, "second", context={"north": 2})

    assert happened_before(first, second)
    assert not happened_before(second, first)


def test_concurrent_observations_are_preserved_as_explicit_conflict() -> None:
    baseline = operation("baseline", 1, "baseline")
    north = operation("north", 1, "north edit", context={"baseline": 1})
    south = operation("south", 1, "south edit", context={"baseline": 1})

    result = materialize([baseline, north, south])

    assert result.state["observation"] is None
    assert [candidate["value"] for candidate in result.conflicts[0]["candidates"]] == [
        "north edit",
        "south edit",
    ]


def test_materialization_is_identical_for_every_arrival_order() -> None:
    operations = [
        operation("baseline", 1, "baseline", operation_id="00000000-0000-0000-0000-000000000001"),
        operation(
            "north",
            1,
            "north edit",
            context={"baseline": 1},
            operation_id="00000000-0000-0000-0000-000000000002",
        ),
        operation(
            "south",
            1,
            "south edit",
            context={"baseline": 1},
            operation_id="00000000-0000-0000-0000-000000000003",
        ),
    ]

    outcomes = {
        (
            materialize(list(order)).state_digest,
            tuple(materialize(list(order)).version_vector.items()),
        )
        for order in permutations(operations)
    }

    assert len(outcomes) == 1


def test_scalar_lww_tie_breaker_is_stable_and_arrival_independent() -> None:
    north = operation(
        "north",
        1,
        "Medium",
        field="priority",
        operation_id="00000000-0000-0000-0000-000000000010",
    )
    south = operation(
        "south",
        1,
        "Urgent",
        field="priority",
        operation_id="00000000-0000-0000-0000-000000000011",
    )

    assert materialize([north, south]).state["priority"] == "Urgent"
    assert materialize([south, north]).state["priority"] == "Urgent"


def test_causally_later_scalar_wins_even_with_lower_stable_dot_key() -> None:
    first = operation("z-device", 8, "High", field="priority")
    later = operation(
        "a-device",
        1,
        "Low",
        field="priority",
        context={"z-device": 8},
    )

    assert materialize([later, first]).state["priority"] == "Low"


def test_human_resolution_must_cover_every_candidate() -> None:
    north = operation("north", 1, "north edit")
    south = operation("south", 1, "south edit")
    candidates = unresolved_observation_candidates([north, south])
    incomplete = operation(
        "supervisor",
        1,
        "combined",
        context={"north": 1},
        kind="resolve",
    )
    complete = operation(
        "supervisor",
        1,
        "combined",
        context={"north": 1, "south": 1},
        kind="resolve",
    )

    assert not resolution_covers_candidates(incomplete, candidates)
    assert resolution_covers_candidates(complete, candidates)
    assert materialize([north, south, complete]).state["observation"] == "combined"


def test_duplicate_operation_set_has_same_digest() -> None:
    item = operation("north", 1, "one value")

    assert materialize([item]).state_digest == materialize([item, item]).state_digest
