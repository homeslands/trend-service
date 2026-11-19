import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { resolve } from 'path';
import { User } from 'src/user/user.entity';
import {
  SharedUserLookupResponse,
  SharedUserServiceClient,
} from 'src/external-services/shared-user-service/shared-user-service.client';
import { batchLookupSharedUserIdentities } from 'src/user/user.helper';
import { MailProducer } from './mail.producer';

// Ten hien thi tu identity cua shared-user. Bo phan rong thay vi in
// "null"/"undefined" nhu khi ghep thang hai cot cuc bo.
const fullNameOf = (identity: SharedUserLookupResponse): string =>
  [identity.firstName, identity.lastName].filter(Boolean).join(' ');

/**
 * Buoc 4.4 - ba method nhan `user: User` (`sendNewPassword`,
 * `sendVerifyEmail`, `sendInvoiceWhenOrderPaid`) lay email, ho ten va co
 * xac minh email cua nguoi nhan tu shared-user (nguon that), KHONG doc
 * `email`/`firstName`/`lastName`/`isVerifiedEmail` tren hang `user_tbl`
 * cuc bo: cot cuc bo chi con la cache (khong duong nao ghi lai khi nguoi dung
 * tu sua ho so o shared-user), va hai co xac minh bi drop o buoc 4.7.
 * Tham so `user` chi con dung de lay `sharedUserId` (va `id`/`slug` cho log).
 *
 * Chinh sach loi theo duong goi - KHONG BAO GIO gui toi dia chi cache cu:
 *   - `sendNewPassword`, `sendVerifyEmail`: nguoi goi CHO mail di (mat khau
 *     moi, ma xac minh) => khong tra duoc nguoi nhan thi NEM. shared-user khong
 *     tra loi => `SharedUserUnavailableException` (503, D9) tu helper; khong
 *     co identity (hoac khong co email voi mat khau moi) =>
 *     `BadRequestException`, cung kieu nhanh gui loi san co.
 *   - `sendInvoiceWhenOrderPaid`: side-effect SAU khi don da thanh toan (cho
 *     goi dang comment o `job.service.ts`, `order.listener.ts`) => KHONG nem:
 *     shared-user hong / khong co identity => bo mail + log, giong nhanh
 *     "email chua xac minh" san co.
 *
 * Ngoai pham vi buoc nay: `sendBirthdayGreeting` (chi trend) nhan san mot
 * object thuong - nguon cua no la producer sinh nhat, buoc 5.6.
 */
@Injectable()
export class MailService {
  constructor(
    private readonly mailProducer: MailProducer,
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: Logger,
    private readonly sharedUserServiceClient: SharedUserServiceClient,
  ) {}

  /**
   * Identity cua nguoi nhan, hoi shared-user theo `sharedUserId`.
   * shared-user khong tra loi => helper ghi log va nem
   * `SharedUserUnavailableException`; khong co identity => `warn` + null.
   */
  private async recipientOf(
    user: User,
    context: string,
  ): Promise<SharedUserLookupResponse | null> {
    const identities = await batchLookupSharedUserIdentities(
      [user.sharedUserId],
      this.sharedUserServiceClient,
      this.logger,
      context,
    );
    const identity = identities.get(user.sharedUserId);
    if (!identity) {
      this.logger.warn(
        `No shared-user identity for user ${user.id} (sharedUserId ${user.sharedUserId}), mail is not sent`,
        context,
      );
      return null;
    }
    return identity;
  }

  async sendNewPassword(user: User, newPassword: string) {
    const context = `${MailService.name}.${this.sendNewPassword.name}`;
    const recipient = await this.recipientOf(user, context);
    if (!recipient?.email) {
      throw new BadRequestException(
        `Error sending email to user ${user.slug}: no email in shared-user`,
      );
    }
    try {
      await this.mailProducer.sendMail({
        to: recipient.email, // list of receivers
        // from: '"Support Team" <support@example.com>', // override default from
        subject: '[Trend Coffee] Reset Password', // Subject line
        template: resolve('public/templates/mail/reset-password'), // `.ejs` extension is appended automatically
        context: {
          name: fullNameOf(recipient),
          newPassword,
        },
      });
    } catch (error) {
      this.logger.error(
        `Error sending email to ${JSON.stringify(error)}`,
        error.stack,
        context,
      );
      throw new BadRequestException(
        `Error sending email to ${recipient.email}`,
      );
    }
    this.logger.log(`Email sent to ${recipient.email}`, context);
  }

  async sendVerifyEmail(
    user: User,
    code: string,
    email: string,
    expiresAt: string,
  ) {
    const context = `${MailService.name}.${this.sendVerifyEmail.name}`;
    const recipient = await this.recipientOf(user, context);
    if (!recipient) {
      throw new BadRequestException(
        `Error sending verify email to user ${user.slug}: no shared-user identity`,
      );
    }
    await this.mailProducer.sendMail({
      to: email,
      subject: '[Trend Coffee] Verify Email',
      template: resolve('public/templates/mail/verify-email'),
      context: {
        name: fullNameOf(recipient),
        code,
        expiresAt,
      },
    });
    this.logger.log(`Email is sending to ${email}`, context);
  }

  async sendBirthdayGreeting(
    user: {
      slug?: string;
      email?: string;
      firstName?: string;
      lastName?: string;
    },
    vouchers: {
      code: string;
      title: string;
      value: number;
      valueType: string;
      products: string[];
    }[] = [],
    // Reward type of the campaign: 'gift' switches the email to the gift
    // (cake) wording; anything else keeps the voucher content.
    rewardType?: string,
  ) {
    const context = `${MailService.name}.${this.sendBirthdayGreeting.name}`;
    await this.mailProducer.sendMail({
      to: user.email,
      subject: '[Trend Coffee] Chúc mừng sinh nhật!',
      template: resolve('public/templates/mail/birthday'),
      context: {
        name: `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim(),
        id: user.slug ?? '',
        vouchers,
        rewardType,
      },
      // Only gift campaigns show the birthday image (referenced via cid in the
      // template).
      ...(rewardType === 'gift'
        ? {
            attachments: [
              {
                filename: 'birthday-gift.png',
                path: resolve('public/images/birthday-gift.png'),
                cid: 'birthday-gift',
              },
            ],
          }
        : {}),
    });
    this.logger.log(
      `Birthday email is sending to ${user.email} (${vouchers.length} voucher(s))`,
      context,
    );
  }

  async sendInvoiceWhenOrderPaid(user: User, invoice: Buffer) {
    const context = `${MailService.name}.${this.sendInvoiceWhenOrderPaid.name}`;

    let recipient: SharedUserLookupResponse | null;
    try {
      recipient = await this.recipientOf(user, context);
    } catch {
      // Nguyen nhan goc da duoc batchLookupSharedUserIdentities ghi log.
      this.logger.error(
        `Skip invoice email for user ${user.id}: shared-user identity unavailable`,
        context,
      );
      return;
    }

    if (recipient?.email && recipient.isVerifiedEmail) {
      await this.mailProducer.sendMail({
        to: recipient.email,
        subject: '[Trend Coffee] Invoice',
        template: resolve('public/templates/mail/send-invoice'),
        context: {
          name: fullNameOf(recipient),
        },
        attachments: [
          {
            filename: 'invoice.pdf',
            content: invoice.toString('base64'),
            encoding: 'base64',
            contentType: 'application/pdf',
          },
        ],
      });
      this.logger.log(`Invoice is sending to ${recipient.email}`, context);
    }
  }
}
