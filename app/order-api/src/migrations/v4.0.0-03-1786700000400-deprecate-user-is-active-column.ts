import { MigrationInterface, QueryRunner } from 'typeorm';

// Buoc 3.4 (giai doan 3) - cot trang thai khoa CUC BO cua `user_tbl` khong con
// ai doc. Khoa/mo tai khoan nam o `shared-user` tu giai doan 1
// (`UserActiveChecker`, `JwtStrategy`), con `UserResponseDto.isActive` duoc gan
// tu identity (`user.helper.ts` `applyUserIdentity`, `user.service.ts`). Entity
// `User` bo field `isActive` trong cung buoc.
//
// ⛔ DOI TEN, KHONG xoa: `DROP` that chi o giai doan 10 (quy uoc du an; hai dot
// phat hanh - quy dinh 1 cua bon quy dinh migration x script, 14/11/2026).
//
// CHI `user_tbl`. Ten cot nay con co tren chin bang khac nhung la cot cua chinh
// chung (trang thai banner, san pham, voucher...) - migration nay khong duoc
// nhac ten bang nao khac.
//
// `RENAME COLUMN` (MySQL 8) giu nguyen kieu, NOT NULL va `DEFAULT 1`, nen lenh
// INSERT cua entity (khong con khai cot nay) van chay: hang moi nhan mac dinh 1
// o cot da doi ten.
//
// Kiem ten cot truoc khi doi (ca `up()` lan `down()`) de chay lai duoc va khong
// hong o DB da chay roi. Thay CA HAI ten thi nem loi thay vi bo qua: chon bua
// mot ben la doc nham nua du lieu.
const TABLE = 'user_tbl';
const COLUMN = 'is_active_column';
const DEPRECATED = '_deprecated_is_active_column';

export class DeprecateUserIsActiveColumn1786700000400
  implements MigrationInterface
{
  name = 'DeprecateUserIsActiveColumn1786700000400';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const original = await queryRunner.hasColumn(TABLE, COLUMN);
    const deprecated = await queryRunner.hasColumn(TABLE, DEPRECATED);
    if (original && deprecated) {
      throw new Error(`${TABLE} co ca ${COLUMN} lan ${DEPRECATED}`);
    }
    if (!original) return;
    await queryRunner.query(
      'ALTER TABLE `user_tbl` RENAME COLUMN `is_active_column` TO `_deprecated_is_active_column`',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const original = await queryRunner.hasColumn(TABLE, COLUMN);
    const deprecated = await queryRunner.hasColumn(TABLE, DEPRECATED);
    if (original && deprecated) {
      throw new Error(`${TABLE} co ca ${COLUMN} lan ${DEPRECATED}`);
    }
    if (!deprecated) return;
    await queryRunner.query(
      'ALTER TABLE `user_tbl` RENAME COLUMN `_deprecated_is_active_column` TO `is_active_column`',
    );
  }
}
