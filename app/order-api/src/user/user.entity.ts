import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { Base } from 'src/app/base.entity';
import { AutoMap } from '@automapper/classes';
import { Branch } from 'src/branch/branch.entity';
import { Order } from 'src/order/order.entity';
import { Role } from 'src/role/role.entity';
import { CardOrder } from 'src/gift-card-modules/card-order/entities/card-order.entity';
import { Recipient } from 'src/gift-card-modules/receipient/entities/receipient.entity';
import { GiftCard } from 'src/gift-card-modules/gift-card/entities/gift-card.entity';
import { UserGroupMember } from 'src/user-group-member/user-group-member.entity';
import { FirebaseDeviceToken } from 'src/notification/firebase/firebase-device-token.entity';
import { Voucher } from 'src/voucher/entity/voucher.entity';
import { CampaignRecipient } from 'src/campaign/entity/campaign-recipient.entity';

@Entity('user_tbl')
export class User extends Base {
  // Id that cua user ben shared-user (identity service) - dung de JwtStrategy
  // map JWT payload.sub sang user cuc bo cua trend. Luon co gia tri (NOT NULL
  // tu sau migration backfill v4.0.0-02).
  //
  // **Mot phan hang mang gia tri BANG CHINH `id_column` cua no, va do la
  // DUNG** - khong phai no tam. Hai DB tach ra tu cung mot mono nen giu
  // nguyen khoa chinh, vi the hang cu trung nhau o ca hai ben. Hang tao sau
  // khi tach thi `id` cuc bo khac, con `sharedUserId` tro dung sang danh
  // tinh that.
  //
  // Da do 05/09/2026: 723/723 hang tra ra mot hang co that ben
  // `shared_user_db`, **0 mo coi** (trong do 175 hang thuoc dien trung khoa
  // noi tren). Chu thich cu o day ghi *"backfill tam... se duoc dong bo lai
  // sau"* - cau do SAI va lam nguoi doc sau tuong con no du lieu (rui ro
  // R8, da bac bo). Xem progress/trend-api.md muc A1/A5.
  @AutoMap()
  @Column({ name: 'shared_user_id_column', unique: true })
  sharedUserId: string;

  // Buoc 8.8: `user_tbl` chi con `sharedUserId` + `role` + `branch` (muc 1.6).
  // Muoi cot identity (phonenumber, password, firstName, lastName, language,
  // dob, dobDM, email, address, image) va ba quan he vi (`balance`,
  // `pointTransactions`, `accumulatedPoint` - FK `accumulated_point_column`)
  // da roi entity: identity doc o shared-user, vi / diem o shared-user. Cot
  // cuc bo doi ten `_deprecated_*` o 8.9, xoa that o giai doan 10. Dung them
  // lai cot nao o day de "tien tay" - do la mo lai ban sao identity.
  //
  // Buoc 3.4: trang thai khoa da roi entity. Khoa/mo nam o `shared-user`
  // (`UserActiveChecker`, `JwtStrategy`); `UserResponseDto.isActive` gan tu
  // identity (`user.helper.ts`). Cot cuc bo doi ten `_deprecated_*` boi
  // migration `v4.0.0-03-1786700000400`, xoa that o giai doan 10.

  // Many to one with branch
  @AutoMap(() => Branch)
  @ManyToOne(() => Branch, (branch) => branch.users)
  @JoinColumn({ name: 'branch_id_column' })
  branch: Branch;

  // One to many with owner order
  @OneToMany(() => Order, (order) => order.owner)
  ownerOrders: Order[];

  // One to many with approval order
  @OneToMany(() => Order, (order) => order.approvalBy)
  approvalOrders: Order[];

  // One to one with role
  @ManyToOne(() => Role, (role) => role.users)
  @JoinColumn({ name: 'role_column' })
  @AutoMap(() => Role)
  role: Role;

  // Buoc 4.7: hai co xac minh (email, SDT) da roi entity. Gia tri that nam o
  // `shared-user`; DTO van khai hai field va gan tu identity (`user.helper.ts`,
  // `UserService.mergeSharedUserIdentity`, `AuthService.getProfile`). Hai cot
  // cuc bo doi ten `_deprecated_*`, xoa that o giai doan 10.

  @OneToMany(() => CardOrder, (cardOrder) => cardOrder.customer, {
    onDelete: 'SET NULL',
  })
  customerCardOrders: CardOrder[];

  @OneToMany(() => CardOrder, (cardOrder) => cardOrder.cashier, {
    onDelete: 'SET NULL',
  })
  cashierCardOrders: CardOrder[];

  @OneToMany(() => Recipient, (receipient) => receipient.recipient, {
    onDelete: 'SET NULL',
  })
  recipientCardOrders: Recipient[];

  @OneToMany(() => Recipient, (receipient) => receipient.sender, {
    onDelete: 'SET NULL',
  })
  senderCardOrders: Recipient[];

  @OneToMany(() => GiftCard, (gc) => gc.usedBy)
  giftCards?: GiftCard[];

  // One to many with user group members
  @OneToMany(() => UserGroupMember, (userGroupMember) => userGroupMember.user)
  userGroupMembers: UserGroupMember[];

  // One to many with device tokens
  @OneToMany(
    () => FirebaseDeviceToken,
    (firebaseDeviceToken) => firebaseDeviceToken.user,
  )
  firebaseDeviceTokens: FirebaseDeviceToken[];

  @OneToMany(() => Voucher, (voucher) => voucher.assignedUser, {
    cascade: ['insert', 'update', 'remove'],
  })
  individualVouchers: Voucher[];

  // QD22 (buoc 2.5) - quan he `membershipCard` va `userRequirements` DA GO:
  // the va requirement nay o shared-user, doc qua
  // `/internal/membership-cards/lookup` va `userRequirements` cua
  // `/internal/users/lookup`. Hai bang cuc bo khong con duoc ghi; doi ten o
  // buoc 8.9, drop o 10.3 - nen entity cua chung VAN O LAI (bang that con
  // ton tai, `synchronize: false` nen khong co rui ro schema).
  //
  // Dung them lai quan he nao o day de "tien tay join": lam vay la mo lai
  // dung nguon ghi lac ma QD22 vua dong.

  @OneToMany(() => CampaignRecipient, (cr) => cr.user)
  campaignRecipients?: CampaignRecipient[];
}
