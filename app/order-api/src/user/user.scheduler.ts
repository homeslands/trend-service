import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from './user.entity';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Role } from 'src/role/role.entity';
import { RoleEnum } from 'src/role/role.enum';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DistributeLockJobKey, QueueRegisterKey } from 'src/app/app.constants';
import Redlock from 'redlock';
import { SharedUserServiceClient } from 'src/external-services/shared-user-service/shared-user-service.client';
import { UserProvisioningService } from './user-provisioning.service';
import {
  SYNC_USERS_FAST_GRID_WINDOW_MINUTES,
  SYNC_USERS_WIDE_GRID_WINDOW_HOURS,
} from './user.constant';

@Injectable()
export class UserScheduler {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    @Inject(WINSTON_MODULE_NEST_PROVIDER) private readonly logger: Logger,
    @InjectQueue(QueueRegisterKey.DISTRIBUTE_LOCK_JOB)
    private readonly distributeLockJobQueue: Queue,
    private readonly sharedUserServiceClient: SharedUserServiceClient,
    // QD19 - lop 3 dung CHUNG `ensureLocalUser` voi ba lop con lai.
    private readonly userProvisioningService: UserProvisioningService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async updateUserRole() {
    const context = `${UserScheduler.name}.${this.updateUserRole.name}`;
    this.logger.log(`Update user role`, context);

    const usersWithoutRole = await this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.role', 'role')
      .where('role.id IS NULL')
      .getMany();

    this.logger.log(
      `Number of users without role: ${usersWithoutRole.length}`,
      context,
    );

    const role = await this.roleRepository.findOne({
      where: {
        name: RoleEnum.Customer,
      },
    });

    if (!role) {
      this.logger.warn(`Role ${RoleEnum.Customer} not found`);
      return;
    }

    const updatedUsers = usersWithoutRole.map((item) => {
      item.role = role;
      return item;
    });

    this.userRepository.manager.transaction(async (manager) => {
      await manager.save(updatedUsers);
    });
    this.logger.log(`Update user role successfully`, context);
  }

  // KHONG con `initSuperAdmin` (chot 11/10/2026, giong terminal - buoc 2.3).
  // Ban cu la ban truoc khi tach: tu ghi `password`/`firstName`/`lastName` vao
  // hang cuc bo va khong gan `sharedUserId` (cot NOT NULL) nen tren DB trang
  // luon hong roi bi nuot trong `catch`. Moi moi truong di tiep tu DB dang
  // chay, DB do da co hang `root` role SuperAdmin tro vao danh tinh `root` ben
  // shared-user. Neu co luc phai dung DB trang thi tao tay hang cuc bo do -
  // QD19 chi cap Customer, QD20 cam nang len.

  // KHONG con `initDefaultCustomer` (buoc 2.9, chot 03/11/2026) - ban nay HONG
  // san, khong chi la "khong con can":
  // - No chen hang MA KHONG GAN `sharedUserId`, ma `shared_user_id_column` la
  //   cot NOT NULL => `save()` luon nem tren DB trang, roi loi bi NUOT vao
  //   `catch` va chi con mot dong log.
  // - No nhan dien sentinel bang `phonenumber` va de DB tu sinh `id`, nen hai
  //   service dung mot DB moi khong the co cung id sentinel - dung thu 2B2 vua
  //   bo di.
  // Viec "bao dam co hang sentinel" chuyen han sang MIGRATION o buoc 2.10.
  //
  // Dong `bcrypt.hash('default-customer', …)` trong than ham la cho GHI
  // `password_column` CUOI CUNG cua `trend` - cung voi viec xoa `initSuperAdmin`
  // (2.3) va doi duong tao the (2.5). Vi vay `bcrypt`, `saltOfRounds` va
  // `ConfigService` het nguoi doc trong tep nay va da go theo; `roleRepository`
  // va `RoleEnum` thi O LAI, `updateUserRole` phia tren con dung.

  // KHONG con `BirthdayStrategyScheduler` (buoc 8.1, QD13). Ngay sinh thuoc
  // shared-user: scheduler cua shared-user tim nguoi co sinh nhat ngay mai va
  // day job `user-birthday-triggered` (chi mang `sharedUserId`) vao queue
  // `user-birthday` cua trend (USER_BIRTHDAY_QUEUE_PREFIX ben do). Phan con lai
  // cua scheduler cu - cap thuong campaign, claim loi chuc, day job theo kenh -
  // nay o `UserBirthdayConsumer.handleBirthdayTriggered`. Quet `dobDM` cuc bo
  // khong con: cot do bi doi ten o 8.9.

  // ==========================================================================
  // QD19 lop 3 + QD21 - HAI LUOI dinh ky, moi cai mot vai
  //
  //   Luoi nhanh  moi 10 phut   cua so [now-30m, now]   bat kip trong ngay
  //   Luoi rong   1 lan/ngay 2h cua so [now-48h, now]   bu moi thu bo lo
  //
  // ### Vi sao phai co CA HAI, chu khong chi ha chu ky job cu xuong
  //
  // Ca hai deu dung **cua so co dinh tinh tu `now`**. Neu service chet (hoac
  // cron hong) lau hon 30 phut, nguoi dang ky trong khoang do bi **bo sot
  // vinh vien**: cron song lai chi quet [now-30m, now], **no khong biet minh
  // da bo lo 4 tieng**, va khong ai backfill lai. Cua so phai rong hon
  // khoang chet te nhat minh chap nhan duoc - 48 gio thi song sot qua mot
  // ngay sap tron ven.
  //
  // Noi cho dung: chet >2 ngay, hoac chinh job 2h sang cung hong, thi **van
  // sot** - no cung la cua so co dinh, chi to hon 96 lan. Day khong phai loi
  // giai tuyet doi (cua so theo `lastRun` moi la), nhung lay ~90% gia tri
  // voi ~10% cong suc.
  // ==========================================================================

  // LUOI NHANH. Chong lan 3 lan (chu ky 10 phut, cua so 30 phut) la CO Y -
  // de khong roi nguoi o dung bien cua so: do tre dong ho, giao dich commit
  // cham.
  @Cron(CronExpression.EVERY_10_MINUTES)
  async syncRecentlyRegisteredUsersFast() {
    const context = `${UserScheduler.name}.${this.syncRecentlyRegisteredUsersFast.name}`;

    const lock = await this.acquireSyncLock(
      DistributeLockJobKey.SYNC_RECENTLY_REGISTERED_USERS_FAST,
      1000 * 60 * 5, // 5 phut - du rong cho mot cua so 30 phut
      context,
    );
    if (!lock) return;

    try {
      const to = new Date();
      const from = new Date(
        to.getTime() - SYNC_USERS_FAST_GRID_WINDOW_MINUTES * 60 * 1000,
      );
      const { created, skippedForeign, total } = await this.syncUserWindow(
        from,
        to,
      );

      // IM LANG khi khong co gi. Ban cu log muc `log` moi luot (ke ca
      // "Found 0 recently registered user, skip"), moi 10 phut, mai mai -
      // do la tieng on che mat moi thu khac.
      if (created || skippedForeign) {
        this.logger.log(
          `Fast grid synced ${created}/${total} user(s), skipped ${skippedForeign} owned by another service`,
          context,
        );
      }
    } catch (error) {
      this.logger.error(
        `Error when running fast grid user sync`,
        error.stack,
        context,
      );
    } finally {
      await lock.release();
    }
  }

  // LUOI RONG. Giu nguyen chu ky 2h sang cua job cu, chi noi cua so tu
  // "ca ngay hom qua" thanh 48 gio.
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async syncRecentlyRegisteredUsers() {
    const context = `${UserScheduler.name}.${this.syncRecentlyRegisteredUsers.name}`;

    const lock = await this.acquireSyncLock(
      DistributeLockJobKey.SYNC_RECENTLY_REGISTERED_USERS,
      // TTL rieng, KHONG be nguyen 5 phut cua luoi nhanh: cua so 48 gio co
      // the la vai nghin hang, chay lau hon 5 phut thi khoa het han giua
      // chung va mot replica khac chen vao.
      1000 * 60 * 30,
      context,
    );
    if (!lock) return;

    try {
      const to = new Date();
      const from = new Date(
        to.getTime() - SYNC_USERS_WIDE_GRID_WINDOW_HOURS * 60 * 60 * 1000,
      );

      this.logger.log(
        `Wide grid sync users registered from ${from.toISOString()} to ${to.toISOString()}`,
        context,
      );

      const { created, skippedForeign, total } = await this.syncUserWindow(
        from,
        to,
      );

      if (created > 0) {
        // ==================================================================
        // DAY MOI LA PHAN GIA TRI NHAT CUA JOB NAY, chu khong phai viec bu.
        //
        // Luoi rong thuong xuyen bu duoc nguoi nghia la **luoi nhanh dang
        // hong ma khong ai biet**. Mot cai luoi an toan AM THAM va loi la
        // cai luoi che mat van de that. Nen o day phai KEU LEN kem so
        // luong - job ngay vua la luoi bu, vua la cam bien suc khoe cua
        // luoi nhanh, ma khong ton them gi.
        // ==================================================================
        this.logger.warn(
          `Wide grid had to provision ${created}/${total} user(s) - the 10-minute fast grid should have caught them. Check whether it is running.`,
          context,
        );
      } else {
        this.logger.log(
          `Wide grid found nothing to provision out of ${total} user(s) - fast grid is healthy`,
          context,
        );
      }
      if (skippedForeign) {
        this.logger.log(
          `Wide grid skipped ${skippedForeign} user(s) owned by another service`,
          context,
        );
      }
    } catch (error) {
      this.logger.error(
        `Error when syncing recently registered users`,
        error.stack,
        context,
      );
    } finally {
      await lock.release();
    }
  }

  // Than chung cua hai luoi. Dung `ensureLocalUsers` - KHONG viet vong
  // insert thu hai (xem UserProvisioningService: hang phong thu la unique
  // constraint, khong phai `exists()`), va loc `ownerService` theo QD18.
  private async syncUserWindow(
    from: Date,
    to: Date,
  ): Promise<{ created: number; skippedForeign: number; total: number }> {
    // Client tu phan trang - cua so 48 gio co the la vai nghin hang (QD21).
    const recentSharedUsers = await this.sharedUserServiceClient.listRecent(
      from,
      to,
    );
    if (!recentSharedUsers.length) {
      return { created: 0, skippedForeign: 0, total: 0 };
    }
    const { created, skippedForeign } =
      await this.userProvisioningService.ensureLocalUsers(recentSharedUsers);
    return { created, skippedForeign, total: recentSharedUsers.length };
  }

  // Hai luoi dung HAI KHOA RIENG (xem DistributeLockJobKey). Khong lay duoc
  // khoa thi bo qua - replica khac dang chay.
  private async acquireSyncLock(
    key: string,
    ttl: number,
    context: string,
  ): Promise<{ release: () => Promise<unknown> } | null> {
    const client = await this.distributeLockJobQueue.client;
    const redlock = new Redlock([client]);
    try {
      return await redlock.acquire([key], ttl);
    } catch {
      this.logger.log(
        `Another replica is already running ${key}, skip`,
        context,
      );
      return null;
    }
  }
}
