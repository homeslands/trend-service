import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuthProfileResponseDto } from './auth.dto';
import { User } from 'src/user/user.entity';
import { InjectMapper } from '@automapper/nestjs';
import { Mapper } from '@automapper/core';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { UserUtils } from 'src/user/user.utils';
import { SharedUserServiceClient } from 'src/external-services/shared-user-service/shared-user-service.client';
import { toUserRequirementResponses } from 'src/external-services/shared-user-service/shared-user-shape.mapper';

/**
 * Buoc 3.2 (giai doan 3) - sau khi xoa SAU route xac minh email/SDT va sau
 * method cua chung, class nay chi con `getProfile`.
 *
 * - Ban THAT cua sau route do nam o `shared-user` (`auth.controller.ts`
 *   L180-299, do 12/11/2026); ca `trend-ui` lan `terminal-ui` goi thang sang
 *   do qua `httpAuth`, nen xoa ban o day khong lam vo luong nao.
 * - Ba helper chet xoa theo: `getZaloOaConnectorConfig`, `getFrontendUrl`,
 *   `getBackendUrl`. Hai ten sau TRUNG voi helper cua class khac
 *   (`NotificationUtils`, `PrinterEventUtils`, `UserBirthdayConsumer` - moi
 *   lop mot ban rieng), nen da kiem tung cho goi truoc khi xoa: khong ai goi
 *   ban cua `AuthService`.
 * - Constructor tu 13 tham so xuong 4. Bo di: `configService` + nam field
 *   `duration` / `refeshableDuration` / `zaloOaApiKey` / `zaloOaSecretKey` /
 *   `zaloOaId` (do 12/11/2026: chi duoc GHI trong constructor, 0 luot doc),
 *   `userRepository` (0 luot dung), va `verifyEmailRepository`,
 *   `verifyPhoneNumberRepository`, `mailService`, `systemConfigService`,
 *   `transactionManagerService`, `zaloOaConnectorClient`,
 *   `zaloOaConnectorConfigRepository` - chung chi phuc vu phan vua xoa.
 *
 * ESLint `no-unused-vars` KHONG bat duoc tham so constructor (chung la thuoc
 * tinh cua class), nen danh sach tren do bang cach dem `this.<ten>` trong phan
 * than con lai. Dung dung cach do khi don tiep o 3.3 / 4.x.
 */
@Injectable()
export class AuthService {
  constructor(
    @InjectMapper()
    private readonly mapper: Mapper,
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: Logger,
    private readonly userUtils: UserUtils,
    private readonly sharedUserServiceClient: SharedUserServiceClient,
  ) {}

  // updateProfile/uploadAvatar da bi xoa khoi trend cung PATCH /auth/profile,
  // PATCH /auth/upload - identity (ho ten, avatar...) thuoc ve shared-user,
  // client ghi thang sang do (xem auth.controller.ts).

  /**
   * Handle retrieve user profile
   *
   * This method retrieves detailed user information.
   *
   * @param {string} userId
   * @returns {Promise<AuthProfileResponseDto>} User profile
   * @throws {AuthException} Throw if user not found
   */
  async getProfile({
    userId,
  }: {
    userId: string;
  }): Promise<AuthProfileResponseDto> {
    const context = `${AuthService.name}.${this.getProfile.name}`;
    const user = await this.userUtils.getUser({
      where: { id: userId },
      relations: {
        branch: {
          addressDetail: true,
        },
        // Khong load role.permissions - khong noi nao doc field nay tu
        // response profile (check quyen luon di qua GET /auth/scope, xem
        // usePermissions() ben trend-ui), load them chi ton 1 join DB thua.
        role: true,
      },
    });
    const dto = this.mapper.map(user, User, AuthProfileResponseDto);
    // QD22 (buoc 2.5): requirement nay o shared-user. Field van co trong
    // response (muc 1.4), nhung gia tri lay tu `lookup` ngay duoi. Dat `[]`
    // truoc khi goi de nhanh fail-open khong tra ve `undefined`.
    dto.userRequirements = [];
    // Buoc 4.7: hai co xac minh khong con cot cuc bo - dat `false` truoc khi
    // goi de nhanh fail-open (va user khong co identity) van giu du key, kieu
    // boolean (muc 1.4). Co identity thi ghi de ben duoi.
    dto.isVerifiedEmail = false;
    dto.isVerifiedPhonenumber = false;
    // Ghep identity moi nhat tu shared-user - role/branch da dung ban cuc
    // bo (nguon that), identity phai hoi lai shared-user thay vi doc cache
    // cuc bo co the cu (architect-http.md muc 1.1 quy tac 4). Fail-open:
    // day la enrichment hien thi, khong phai kiem tra bao mat, loi mang chi
    // log warning, tra ve bang cache cuc bo thay vi lam hong ca request.
    try {
      const identity = await this.sharedUserServiceClient.lookupById(
        user.sharedUserId,
      );
      if (identity) {
        Object.assign(dto, {
          phonenumber: identity.phonenumber ?? dto.phonenumber,
          firstName: identity.firstName ?? dto.firstName,
          lastName: identity.lastName ?? dto.lastName,
          dob: identity.dob ?? dto.dob,
          email: identity.email ?? dto.email,
          address: identity.address ?? dto.address,
          image: identity.image ?? dto.image,
          // Ngon ngu cung la identity (architect-http.md muc 1.6): doi o
          // service nay thi service kia phai thay - doc cot cuc bo la tra
          // ban cu cua rieng service do.
          language: identity.language ?? dto.language,
          isVerifiedEmail: identity.isVerifiedEmail ?? dto.isVerifiedEmail,
          isVerifiedPhonenumber:
            identity.isVerifiedPhonenumber ?? dto.isVerifiedPhonenumber,
          userRequirements: toUserRequirementResponses(
            identity.userRequirements,
          ),
        });
      }
    } catch (error) {
      // Fail-open co san cua profile: giu nguyen chinh sach (day la enrichment
      // hien thi). Hau qua moi tu 2.5: `userRequirements` ve `[]` thay vi ban
      // cuc bo. Chap nhan duoc vi phep CHAN that nam o duong len don/thanh
      // toan va cho do fail-closed (`assertActive` nem 503) - man hinh thieu
      // nhan "cho hoan tat dang ky" mot luc khong mo duoc cua nao.
      this.logger.warn(
        `Failed to enrich profile identity from shared-user, falling back to local cache: ${error?.message}`,
        context,
      );
    }
    return dto;
  }
}
