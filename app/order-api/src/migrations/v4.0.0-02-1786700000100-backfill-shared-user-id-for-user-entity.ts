import { MigrationInterface, QueryRunner } from 'typeorm';

// Backfill du lieu cu cho shared_user_id_column (them boi migration
// v4.0.0-01-1786700000000-add-shared-user-id-for-user-entity.ts). Data cu: gan tam
// bang chinh id_column cua hang hien tai (khong phai id that ben shared-user)
// - chi la placeholder cho du lieu cu, se duoc dong bo lai voi id that sau.
// Data moi tro di (tao qua UserService.updateUserRole) luon duoc gan dung id
// that ben shared-user ngay tu dau, khong di qua placeholder nay.
// Sau buoc backfill, moi hang deu chac chan co gia tri (khong con NULL nao) -
// nen bat buoc NOT NULL luon trong migration nay.
export class BackfillSharedUserIdForUserEntity1786700000100
  implements MigrationInterface
{
  name = 'BackfillSharedUserIdForUserEntity1786700000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE \`user_tbl\` SET \`shared_user_id_column\` = \`id_column\` WHERE \`shared_user_id_column\` IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`user_tbl\` CHANGE \`shared_user_id_column\` \`shared_user_id_column\` varchar(36) NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`user_tbl\` CHANGE \`shared_user_id_column\` \`shared_user_id_column\` varchar(36) NULL`,
    );
  }
}
