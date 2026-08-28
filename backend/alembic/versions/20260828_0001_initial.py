"""Create FieldMerge synchronization tables.

Revision ID: 20260828_0001
Revises:
Create Date: 2026-08-28 14:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260828_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "documents",
        sa.Column("document_id", sa.String(length=128), nullable=False),
        sa.Column("state", sa.JSON(), nullable=False),
        sa.Column("conflicts", sa.JSON(), nullable=False),
        sa.Column("version_vector", sa.JSON(), nullable=False),
        sa.Column("state_digest", sa.String(length=64), nullable=False),
        sa.Column("latest_sequence", sa.Integer(), nullable=False),
        sa.Column("snapshot_sequence", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("document_id"),
    )
    op.create_table(
        "operations",
        sa.Column("server_sequence", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("operation_id", sa.String(length=36), nullable=False),
        sa.Column("document_id", sa.String(length=128), nullable=False),
        sa.Column("actor_id", sa.String(length=64), nullable=False),
        sa.Column("actor_counter", sa.Integer(), nullable=False),
        sa.Column("context", sa.JSON(), nullable=False),
        sa.Column("field", sa.String(length=32), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["document_id"], ["documents.document_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("server_sequence"),
        sa.UniqueConstraint(
            "document_id",
            "actor_id",
            "actor_counter",
            name="uq_operation_dot",
        ),
        sa.UniqueConstraint("operation_id", name="uq_operations_operation_id"),
    )
    op.create_index("ix_operations_operation_id", "operations", ["operation_id"])
    op.create_index(
        "ix_operations_document_sequence",
        "operations",
        ["document_id", "server_sequence"],
    )
    op.create_table(
        "snapshots",
        sa.Column("document_id", sa.String(length=128), nullable=False),
        sa.Column("server_sequence", sa.Integer(), nullable=False),
        sa.Column("state", sa.JSON(), nullable=False),
        sa.Column("conflicts", sa.JSON(), nullable=False),
        sa.Column("version_vector", sa.JSON(), nullable=False),
        sa.Column("state_digest", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["document_id"], ["documents.document_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("document_id"),
    )


def downgrade() -> None:
    op.drop_table("snapshots")
    op.drop_index("ix_operations_document_sequence", table_name="operations")
    op.drop_index("ix_operations_operation_id", table_name="operations")
    op.drop_table("operations")
    op.drop_table("documents")
