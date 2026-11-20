import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobsOptions, Queue } from 'bullmq';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { QueueRegisterKey } from 'src/app/app.constants';
import { AvailableBirthdayCampaign } from 'src/campaign/campaign.constants';
import { SharedUserLookupResponse } from 'src/external-services/shared-user-service/shared-user-service.client';
import { User } from './user.entity';
import {
  BirthdayJobData,
  SEND_BIRTHDAY_EMAIL_JOB,
  SEND_BIRTHDAY_MULTI_CHANNEL_JOB,
} from './user-birthday.constants';

@Injectable()
export class UserBirthdayProducer {
  constructor(
    @InjectQueue(QueueRegisterKey.USER_BIRTHDAY)
    private readonly birthdayQueue: Queue,
    @Inject(WINSTON_MODULE_NEST_PROVIDER) private readonly logger: Logger,
  ) {}

  /**
   * Enqueue a birthday greeting for a user under a given campaign:
   *  - one multi-channel message (Zalo -> SMS fallback), if the user has a phone;
   *    deduplicated per user so multiple campaigns don't send duplicate messages.
   *  - one email (content depends on the campaign), if the user has an email.
   */
  async enqueueUser(
    user: User,
    campaign: AvailableBirthdayCampaign,
    identity: SharedUserLookupResponse,
  ): Promise<void> {
    const context = `${UserBirthdayProducer.name}.${this.enqueueUser.name}`;
    // Buoc 5.6 (5.2(a)): noi dung loi chuc (SDT, email, ho ten) lay tu
    // `identity` cua shared-user ma nguoi goi da tra MOT luot cho ca lo - KHONG
    // chep tu ban sao cuc bo cua `User`, va khong roi ve email / SDT cuc bo khi
    // identity thieu (khong bao gio gui toi dia chi cache cu - nhu buoc 4.4).
    // `id` / `slug` van la khoa cua trend (khoa job, tra voucher, log).
    const data: BirthdayJobData = {
      id: user.id,
      slug: user.slug,
      phonenumber: identity.phonenumber,
      email: identity.email,
      firstName: identity.firstName,
      lastName: identity.lastName,
      campaignId: campaign.id,
      campaignSlug: campaign.slug,
      rewardType: campaign.rewardType,
    };

    const baseOpts: JobsOptions = {
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    };

    const enqueued: string[] = [];

    // Congrats message is campaign-agnostic -> one per user (deduped across campaigns).
    if (data.phonenumber) {
      await this.birthdayQueue.add(SEND_BIRTHDAY_MULTI_CHANNEL_JOB, data, {
        ...baseOpts,
        jobId: `${SEND_BIRTHDAY_MULTI_CHANNEL_JOB}:${user.id}`,
      });
      enqueued.push(SEND_BIRTHDAY_MULTI_CHANNEL_JOB);
    }

    // Email content is campaign-specific -> one per campaign.
    if (data.email) {
      await this.birthdayQueue.add(SEND_BIRTHDAY_EMAIL_JOB, data, {
        ...baseOpts,
        jobId: `${SEND_BIRTHDAY_EMAIL_JOB}:${campaign.id}:${user.id}`,
      });
      enqueued.push(SEND_BIRTHDAY_EMAIL_JOB);
    }

    this.logger.log(
      `Enqueued birthday greeting for user ${user.slug} (campaign ${campaign.slug}) on [${enqueued.join(', ')}]`,
      context,
    );
  }
}
