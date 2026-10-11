"""add recorded word alignment cache

Revision ID: f8c0a2b4d613
Revises: d4a6b8c0e212
"""
from alembic import op
import sqlalchemy as sa

revision = "f8c0a2b4d613"
down_revision = "d4a6b8c0e212"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("record_word_alignments",
        sa.Column("record_id", sa.Integer(), nullable=False, autoincrement=False),
        sa.Column("words", sa.JSON(), nullable=False),
        sa.Column("duration", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["record_id"], ["practice_records.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("record_id"))


def downgrade():
    op.drop_table("record_word_alignments")
