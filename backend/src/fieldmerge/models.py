from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class DocumentRecord(Base):
    __tablename__ = "documents"

    document_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    state: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    conflicts: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    version_vector: Mapped[dict[str, int]] = mapped_column(JSON, nullable=False, default=dict)
    state_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    latest_sequence: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    snapshot_sequence: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    operations: Mapped[list["OperationRecord"]] = relationship(
        back_populates="document", cascade="all, delete-orphan"
    )
    snapshot: Mapped["SnapshotRecord | None"] = relationship(
        back_populates="document", cascade="all, delete-orphan", uselist=False
    )


class OperationRecord(Base):
    __tablename__ = "operations"
    __table_args__ = (
        UniqueConstraint("operation_id", name="uq_operations_operation_id"),
        UniqueConstraint("document_id", "actor_id", "actor_counter", name="uq_operation_dot"),
        Index("ix_operations_document_sequence", "document_id", "server_sequence"),
    )

    server_sequence: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    operation_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    document_id: Mapped[str] = mapped_column(
        ForeignKey("documents.document_id", ondelete="CASCADE"), nullable=False
    )
    actor_id: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_counter: Mapped[int] = mapped_column(Integer, nullable=False)
    context: Mapped[dict[str, int]] = mapped_column(JSON, nullable=False)
    field: Mapped[str] = mapped_column(String(32), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    document: Mapped[DocumentRecord] = relationship(back_populates="operations")


class SnapshotRecord(Base):
    __tablename__ = "snapshots"

    document_id: Mapped[str] = mapped_column(
        ForeignKey("documents.document_id", ondelete="CASCADE"), primary_key=True
    )
    server_sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    state: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    conflicts: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False)
    version_vector: Mapped[dict[str, int]] = mapped_column(JSON, nullable=False)
    state_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    document: Mapped[DocumentRecord] = relationship(back_populates="snapshot")
