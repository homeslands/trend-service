import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from './user.entity';
import { Repository } from 'typeorm';
import { Cron, CronExpression, Timeout } from '@nestjs/schedule';
import { Role } from 'src/role/role.entity';
import { RoleEnum } from 'src/role/role.enum';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import * as bcrypt from 'bcrypt';
import { ConfigService } from '@nestjs/config';
import { UserBirthdayProducer } from './user-birthday.producer';
import { CampaignService } from 'src/campaign/campaign.service';
import { CampaignType } from 'src/campaign/campaign.constants';
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
  private saltOfRounds: number;
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    @Inject(WINSTON_MODULE_NEST_PROVIDER) private readonly logger: Logger,
    private readonly configService: ConfigService,
    private readonly userBirthdayProducer: UserBirthdayProducer,
    private readonly campaignService: CampaignService,
    @InjectQueue(QueueRegisterKey.DISTRIBUTE_LOCK_JOB)
    private readonly distributeLockJobQueue: Queue,
    private readonly sharedUserServiceClient: SharedUserServiceClient,
    // QD19 - lop 3 dung CHUNG `ensureLocalUser` voi ba lop con lai.
    private readonly userProvisioningService: UserProvisioningService,
  ) {
    this.saltOfRounds = this.configService.get<number>('SALT_ROUNDS');
  }

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

  // Create super user if not exist
  @Timeout(5000)
  async initSuperAdmin() {
    const context = `${UserScheduler.name}.${this.initSuperAdmin.name}`;
    this.logger.log(`Initializing super admin...`, context);

    const hasSuperAdmin = await this.userRepository.exists({
      where: {
        phonenumber: 'root',
      },
    });
    if (hasSuperAdmin) {
      this.logger.warn(`Super admin already existed...`, context);
      return;
    }

    const role = await this.roleRepository.findOne({
      where: {
        name: RoleEnum.SuperAdmin,
      },
    });
    if (!role) {
      this.logger.warn(`Role ${RoleEnum.SuperAdmin} not found`, context);
      return;
    }

    // Create supper admin
    const superAdmin = new User();
    const hashedPass = await bcrypt.hash('root', this.saltOfRounds);
    Object.assign(superAdmin, {
      role,
      phonenumber: 'root',
      firstName: 'Super',
      lastName: 'Admin',
      password: hashedPass,
    } as User);
    try {
      await this.userRepository.save(superAdmin);
      this.logger.log(`Super admin root/root created successfuly`, context);
    } catch (error) {
      this.logger.error(
        `Error when creating super admin: ${error.message}`,
        error.stack,
        context,
      );
    }
  }

  @Timeout(5000)
  async initDefaultCustomer() {
    const context = `${UserScheduler.name}.${this.initDefaultCustomer.name}`;
    this.logger.log(`Initializing default customer...`, context);

    const hasDefaultCustomer = await this.userRepository.exists({
      where: {
        phonenumber: 'default-customer',
      },
    });
    if (hasDefaultCustomer) {
      this.logger.warn(`Default customer already existed...`, context);
      return;
    }

    const role = await this.roleRepository.findOne({
      where: {
        name: RoleEnum.Customer,
      },
    });
    if (!role) {
      this.logger.warn(`Role ${RoleEnum.Customer} not found`, context);
      return;
    }

    // Create default customer
    const defaultCustomer = new User();
    const hashedPass = await bcrypt.hash('default-customer', this.saltOfRounds);
    Object.assign(defaultCustomer, {
      role,
      phonenumber: 'default-customer',
      firstName: 'Default',
      lastName: 'Customer',
      password: hashedPass,
    } as User);
    try {
      await this.userRepository.save(defaultCustomer);
      this.logger.log(`Default customer created successfuly`, context);
    } catch (error) {
      this.logger.error(
        `Error when creating default customer: ${error.message}`,
        error.stack,
        context,
      );
    }
  }
  // Return tomorrow's day-month (DDMM). Birthday greetings are sent one day
  // ahead, so we match users whose birthday is tomorrow. Adding a day to the
  // Date handles month/year rollover (e.g. 31/12 -> 01/01, 28/02 -> 01/03).
  processBirthday(): string {
    const now: Date = new Date();
    now.setDate(now.getDate() + 1);
    const day: string = String(now.getDate()).padStart(2, '0');
    const month: string = String(now.getMonth() + 1).padStart(2, '0');
    return day + month;
  }

  @Cron(CronExpression.EVERY_DAY_AT_5PM)
  async BirthdayStrategyScheduler() {
    const context = `${UserScheduler.name}.${this.BirthdayStrategyScheduler.name}`;

    // Distributed lock: with multiple app instances, only one may run the daily
    // birthday sender. The lock is held for its TTL so a second instance
    // starting within the window is skipped (no duplicate greeting jobs).
    const client = await this.distributeLockJobQueue.client;
    const redlock = new Redlock([client]);
    const key = DistributeLockJobKey.SEND_BIRTHDAY_EVERY_DAY_AT_1AM;
    const ttl = 1000 * 60 * 2; // 2 minutes
    const resource = [key];
    let lock: any = null;

    try {
      lock = await redlock.acquire(resource, ttl);
      this.logger.log(
        `Lock success for send birthday every day at 1am`,
        context,
      );

      // Only run the birthday sender when a birthday campaign is available.
      // Each campaign's reward type decides which channels are used:
      // voucher -> SMS + Email, gift -> SMS + Zalo + Email.
      const campaigns =
        await this.campaignService.getAvailableBirthdayCampaigns();
      if (campaigns.length === 0) {
        this.logger.log(
          `No available ${CampaignType.USER_BIRTHDAY} campaign, skipping birthday sender`,
          context,
        );
        return;
      }

      const tomorrowDM = this.processBirthday();
      const users = await this.userRepository.find({
        where: {
          dobDM: tomorrowDM,
        },
      });

      if (users.length === 0) {
        this.logger.log(
          `Found 0 user that has birthday tomorrow (${tomorrowDM})`,
          context,
        );
        return;
      }

      this.logger.log(
        `Found ${users.length} user(s) with birthday tomorrow (${tomorrowDM}). Enqueuing to Redis...`,
        context,
      );

      // Write each birthday user into Redis; the UserBirthdayProducer fans each
      // user out into per-channel jobs (based on the reward type) that the
      // UserBirthdayConsumer processes independently and at the same time.
      const year = new Date().getFullYear();
      for (const user of users) {
        // Cấp phần thưởng cho mọi campaign USER_BIRTHDAY đang mở (voucher hoặc
        // gift) — tạo CampaignRecipient nếu chưa có — trước khi gửi lời chúc.
        // Thay cho luồng CampaignScheduler.handleBirthdayCampaigns (1AM) đã ẩn:
        // gộp grant + greet vào một luồng duy nhất, chạy trước sinh nhật 1 ngày.
        await this.campaignService.triggerForUser(
          user,
          CampaignType.USER_BIRTHDAY,
        );

        for (const campaign of campaigns) {
          // Only greet valid recipients (Flow 1 granted the reward this year),
          // and at most once per year. Claim the greeting here — before fanning
          // out to channels — so a re-run enqueues nothing (neither Zalo/SMS nor
          // email), instead of gating each channel separately.
          const recipient = await this.campaignService.findBirthdayRecipient(
            campaign.id,
            user.id,
            year,
          );
          if (!recipient) {
            this.logger.warn(
              `User ${user.slug} is not a valid birthday recipient for campaign ${campaign.slug} in ${year}, skip`,
              context,
            );
            continue;
          }
          const claimed = await this.campaignService.claimBirthdayGreeting(
            recipient.id,
          );
          if (!claimed) {
            this.logger.warn(
              `User ${user.slug} already greeted for campaign ${campaign.slug} in ${year}, skip`,
              context,
            );
            continue;
          }
          await this.userBirthdayProducer.enqueueUser(user, campaign);
        }
      }

      this.logger.log(
        `Enqueued ${users.length} birthday greeting job(s)`,
        context,
      );
    } catch (error) {
      if (lock) {
        await lock.release();
        this.logger.log(
          `Lock released for send birthday every day at 1am`,
          context,
        );
      }
      this.logger.error(
        `Error when sending birthday greetings`,
        error.stack,
        context,
      );
      return;
    }
  }

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
