import pytest

from fieldmerge.config import Settings


@pytest.mark.parametrize(
    ("environment_value", "expected"),
    [
        ("http://localhost:3002", ["http://localhost:3002"]),
        (
            "http://localhost:3002, https://fieldmerge.example.com",
            ["http://localhost:3002", "https://fieldmerge.example.com"],
        ),
        (
            '["http://frontend:3002", "https://fieldmerge.example.com"]',
            ["http://frontend:3002", "https://fieldmerge.example.com"],
        ),
    ],
)
def test_cors_origins_accept_plain_and_comma_separated_environment_values(
    monkeypatch: pytest.MonkeyPatch,
    environment_value: str,
    expected: list[str],
) -> None:
    monkeypatch.setenv("FIELDMERGE_CORS_ORIGINS", environment_value)

    settings = Settings(_env_file=None)  # type: ignore[call-arg]

    assert settings.cors_origins == expected
