import { MigrationInterface, QueryRunner } from 'typeorm';

// Them cot tham chieu id that cua user ben shared-user (identity service).
// Nullable truoc - backfill du lieu cu duoc tach rieng sang migration
// v4.0.0-02-1786700000100-backfill-shared-user-id-for-user-entity.ts.
export class AddSharedUserIdForUserEntity1786700000000
  implements MigrationInterface
{
  name = 'AddSharedUserIdForUserEntity1786700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`user_tbl\` ADD \`shared_user_id_column\` varchar(36) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`user_tbl\` ADD UNIQUE INDEX \`IDX_user_tbl_shared_user_id_column\` (\`shared_user_id_column\`)`,
    );
    // Role-only user (tao qua UserService.updateUserRole) khong co mat khau
    // cuc bo - password_column khong con la bat buoc.
    await queryRunner.query(
      `ALTER TABLE \`user_tbl\` CHANGE \`password_column\` \`password_column\` varchar(255) NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Note: revert fails if any row was created without a password after
    // this migration (role-only users) - backfill/delete those rows first.
    await queryRunner.query(
      `ALTER TABLE \`user_tbl\` CHANGE \`password_column\` \`password_column\` varchar(255) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`user_tbl\` DROP INDEX \`IDX_user_tbl_shared_user_id_column\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`user_tbl\` DROP COLUMN \`shared_user_id_column\``,
    );
  }
}
