import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindManyOptions,
  FindOptionsWhere,
  In,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { User } from './user.entity';
import { UserProvisioningService } from './user-provisioning.service';
import { batchLookupSharedUserIdentities } from './user.helper';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueRegisterKey } from 'src/app/app.constants';
import {
  DEFAULT_CUSTOMER_SHARED_ID,
  LOOKUP_ON_MISS_PHONENUMBER_PATTERN,
  LOOKUP_ON_MISS_TIMEOUT_MS,
  SYNC_RECENT_USERS_THROTTLE_KEY,
  SYNC_RECENT_USERS_THROTTLE_SECONDS,
  SYNC_RECENT_USERS_TIMEOUT_MS,
  SYNC_RECENT_USERS_WINDOW_MINUTES,
} from './user.constant';
import { InjectMapper } from '@automapper/nestjs';
import { Mapper } from '@automapper/core';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import {
  AccountRevenueCustomerResponseDto,
  AccountRevenueQueryResponseDto,
  AccountRevenueStatisticItemDto,
  AccountRevenueStatisticQueryResponseDto,
  AccountRevenueSummaryResponseDto,
  AggregateAccountRevenueResponseDto,
  CompleteUserRegistrationRequestDto,
  CreateUserRequestDto,
  ExportUserQueryRequestDto,
  GetAccountRevenueQueryDto,
  GetAllUserQueryRequestDto,
  GetUserStatisticsQueryRequestDto,
  LookupRecipientQueryRequestDto,
  RecipientResponseDto,
  UpdateUserLanguageRequestDto,
  UpdateUserRequestDto,
  UpdateUserRoleRequestDto,
  UserResponseDto,
  UserStatisticItemDto,
  UserStatisticsResponseDto,
} from './user.dto';
import { AppPaginatedResponseDto } from 'src/app/app.dto';
import { ConfigService } from '@nestjs/config';
import { Role } from 'src/role/role.entity';
import { UserException } from './user.exception';
import { UserValidation } from './user.validation';
import { RoleValidation } from 'src/role/role.validation';
import { RoleException } from 'src/role/role.exception';
import * as _ from 'lodash';
import { BranchValidation } from 'src/branch/branch.validation';
import { BranchException } from 'src/branch/branch.exception';
import { Branch } from 'src/branch/branch.entity';
import { AuthException } from 'src/auth/auth.exception';
import { AuthValidation } from 'src/auth/auth.validation';
import { RoleEnum } from 'src/role/role.enum';
import { SharedBalanceService } from 'src/shared/services/shared-balance.service';
import { AuthProfileResponseDto } from 'src/auth/auth.dto';
import {
  AccountRevenueCustomerType,
  DobFilterType,
  UserRequirementKey,
  UserRequirementLevel,
  UserRequirementScope,
  UserRequirementStatus,
  UserStatisticsGroupBy,
} from './user.constant';
import {
  getAccountRevenueClause,
  getAccountRevenueStatisticClause,
} from './user.clause';
import { RevenueValidation } from 'src/revenue/revenue.validation';
import { RevenueException } from 'src/revenue/revenue.exception';
import { BranchUtils } from 'src/branch/branch.utils';
import moment from 'moment';
import ExcelJS from 'exceljs';
import { TransactionManagerService } from 'src/db/transaction-manager.service';
import { CampaignAction } from 'src/campaign/campaign.constants';
import {
  SharedUserLookupResponse,
  SharedUserRequirement,
  SharedUserServiceClient,
} from 'src/external-services/shared-user-service/shared-user-service.client';
import { SharedUserUnavailableException } from 'src/external-services/shared-user-service/shared-user-service.exception';
import {
  toMembershipCardResponse,
  toUserRequirementResponses,
} from 'src/external-services/shared-user-service/shared-user-shape.mapper';

// Ma loi `USER_NOT_FOUND` cua `shared-user` (user.validation.ts: 137000) -
// nam trong BODY, HTTP status la 400. Xem toSharedUserCommandError.
const SHARED_USER_USER_NOT_FOUND_CODE = 137000;

@Injectable()
export class UserService {
  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Branch)
    private readonly branchRepository: Repository<Branch>,
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    @InjectMapper()
    private readonly mapper: Mapper,
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: Logger,
    private readonly sharedBalanceService: SharedBalanceService,
    private readonly transactionManagerService: TransactionManagerService,
    private readonly eventEmitter: EventEmitter2,
    private readonly branchUtils: BranchUtils,
    private readonly sharedUserServiceClient: SharedUserServiceClient,
    // QD19 - MOT duong tao hang user cuc bo dung chung cho ca bon lop.
    private readonly userProvisioningService: UserProvisioningService,
    // Dung lai Redis da co san cho Redlock, chi de lam throttle cua lop 1
    // (khoa RIENG, khong dung chung voi khoa cua cron - xem QD21).
    @InjectQueue(QueueRegisterKey.DISTRIBUTE_LOCK_JOB)
    private readonly distributeLockJobQueue: Queue,
  ) {}

  // Buoc 8.3: so ngay sinh vua nhap (DD/MM/YYYY) voi hom nay - khong con cot
  // `dobDM` cuc bo (ngay sinh thuoc shared-user).
  private isTodayBirthday(dob: string | null | undefined): boolean {
    const [day, month] = dob ? dob.split('/') : [];
    if (!day || !month) return false;
    const today = new Date();
    return (
      Number(day) === today.getDate() && Number(month) === today.getMonth() + 1
    );
  }

  // Ghep field identity moi nhat tu shared-user vao 1 UserResponseDto da map
  // tu entity cuc bo - dung cho cac endpoint "can du lieu ca 2 ben"
  // (architect-http.md muc 1.1 quy tac 4): role/branch/sharedUserId lay tu
  // trend, identity lay tu shared-user thay vi cache cuc bo co the cu.
  // Fail-open: day la enrichment hien thi, khong phai kiem tra bao mat nhu
  // isActive trong JwtStrategy (cho van fail-closed, khong doi) - loi mang
  // chi log warning, khong lam hong ca request.
  private mergeSharedUserIdentity(
    dto: UserResponseDto,
    identity: {
      phonenumber?: string;
      firstName?: string;
      lastName?: string;
      dob?: string;
      email?: string;
      address?: string;
      language?: string;
      isVerifiedEmail?: boolean;
      isVerifiedPhonenumber?: boolean;
      isActive?: boolean;
      userRequirements?: SharedUserRequirement[];
    } | null,
  ): UserResponseDto {
    // `isActive` gan RIENG va gan LUON, ke ca khi khong co identity - KHONG
    // duoc rot ve `dto.isActive`.
    //
    // Khoa/mo khoa tai khoan quy het ve shared-user (architect-http.md muc
    // 1.1), nen cot `is_active_column` ben trend la du lieu chet: khong con
    // ai ghi vao no, mac dinh `true`, va se bi xoa khi ket thuc chuyen doi
    // (user_tbl chi con sharedUserId + role + branch). Lay no lam gia tri du
    // phong nghia la tra ve "dang hoat dong" cho ca tai khoan vua bi khoa -
    // dung lo hong tester ghi ngay 03/09/2026
    // (tests/tester-issues/1.3.9.xlsx dong 38).
    //
    // Khong co identity => `false`. Day khong phai gia tri an toan tuy tien
    // ma la su that: khong co ban ghi ben shared-user thi tai khoan do khong
    // xac thuc duoc (JwtStrategy tra theo sharedUserId roi chan neu khong
    // thay), nen "khong dung duoc" mo ta dung trang thai cua no.
    dto.isActive = identity?.isActive ?? false;
    // Buoc 4.7: hai co xac minh cung gan LUON, nhu `isActive`. Entity da bo hai
    // field nen `dto` khong con gia tri cuc bo nao de rot ve - bo trong la key
    // bien mat khoi response (muc 1.4). Khong co identity => `false`.
    dto.isVerifiedEmail = identity?.isVerifiedEmail ?? false;
    dto.isVerifiedPhonenumber = identity?.isVerifiedPhonenumber ?? false;
    // ⚠ KHONG gan `userRequirements` o day. Ham nay la diem merge dung chung
    // cua 8 route, ma truoc buoc 2.5 chi `GET /user` (danh sach) nap quan he
    // requirement - `GET /user/:slug` va 6 route kia KHONG co field do. Gan o
    // day la them field vao ca 8, tuc doi shape ngoai chu dich (muc 1.4;
    // `response-shape.spec.ts` bat dung cho nay ngay 26/10/2026).
    // Noi gan: `getAllUsers`, canh `membershipCard`.
    //
    // Buoc 8.3: identity CHI lay tu shared-user, khong rot ve `dto` (map tu
    // cot cuc bo, doi ten o 8.9). Khong co identity / shared-user de trong =>
    // de trong (fail-closed, muc 1.7), khong hien ban cuc bo co the da cu.
    // `language` ghep o day tu buoc nay vi cot cuc bo thoi duoc ghi
    // (`updateUserLanguage`) - key da co trong response, chi doi nguon.
    return Object.assign(dto, {
      phonenumber: identity?.phonenumber,
      firstName: identity?.firstName,
      lastName: identity?.lastName,
      dob: identity?.dob,
      email: identity?.email,
      address: identity?.address,
      language: identity?.language,
    });
  }

  async getUserBySlug(slug: string) {
    const context = `${UserService.name}.${this.getUserBySlug.name}`;
    const user = await this.userRepository.findOne({
      where: {
        slug,
      },
      relations: ['branch', 'role'],
    });

    if (!user) {
      this.logger.error(`User not found`, context);
      throw new UserException(UserValidation.USER_NOT_FOUND);
    }

    const dto = this.mapper.map(user, User, UserResponseDto);
    // Fail-closed: goi hong thi tra 503, KHONG rot ve ban cuc bo nua. Ban cuc
    // bo khong con `isActive` that (xem mergeSharedUserIdentity), nen tra ve
    // no la tra ve so lieu sai duoi vo boc 200. Doi lai gan nhu khong mat
    // tinh san sang nao: JwtStrategy da goi chinh shared-user va nem 503
    // trong MOI request co auth, nen shared-user chet thi request khong bao
    // gio di toi duoc day.
    let identity: Awaited<ReturnType<SharedUserServiceClient['lookupById']>>;
    try {
      identity = await this.sharedUserServiceClient.lookupById(
        user.sharedUserId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to enrich user identity from shared-user: ${error?.message}`,
        error?.stack,
        context,
      );
      throw new SharedUserUnavailableException();
    }

    // Co hang cuc bo nhung shared-user khong co danh tinh => nguoi nay khong
    // thuc su ton tai. Tra 404 thay vi 200 kem cac field danh tinh rong
    // (architect-http.md muc 1.7: hang cuc bo KHONG phai bang chung ton tai).
    if (!identity) {
      this.logger.error(
        `Shared-user identity not found for sharedUserId ${user.sharedUserId}`,
        null,
        context,
      );
      throw new UserException(UserValidation.USER_NOT_FOUND);
    }

    return this.mergeSharedUserIdentity(dto, identity);
  }

  // Sua thong tin 1 user (admin-facing). Branch la du lieu cua trend, sua
  // cuc bo binh thuong. Cac field identity (firstName/lastName/dob/email/
  // address) gio thuoc ve shared-user (architect-http.md muc 1.1) - phai ghi
  // sang do TRUOC (fail-closed: shared-user tra loi thi moi luu cuc bo, tranh
  // 2 ban lech nhau vinh vien neu shared-user tu choi vd trung SDT o noi
  // khac), ket qua tra ve ghep tu response cua chinh lan goi do. Tu buoc 8.3
  // KHONG con luu ban sao identity cuc bo: lenh luu cuc bo chi con `branch`.
  //
  // 2 lenh ghi (shared-user + cuc bo) phai la 1 don vi nguyen tu
  // (architect-http.md muc 1.2 - bat buoc): neu buoc luu cuc bo phia duoi
  // that bai SAU KHI shared-user da ghi thanh cong, PHAI goi lai
  // updateIdentity voi gia tri CU de rollback truoc khi bao loi cho client -
  // khong duoc de lai trang thai "shared-user da doi nhung trend bao loi".
  // Gia tri cu duoc snapshot bang 1 lan lookupById NGAY TRUOC KHI ghi (khong
  // dung cot cuc bo lam gia tri cu - cot cuc bo co the da lech vi user co
  // the tu sua qua PATCH {shared-user}/auth/profile, bo qua trend hoan
  // toan).
  async updateUser(slug: string, requestData: UpdateUserRequestDto) {
    const context = `${UserService.name}.${this.updateUser.name}`;
    const user = await this.userRepository.findOne({
      where: { slug },
      relations: ['branch', 'role'],
    });
    if (!user) throw new UserException(UserValidation.USER_NOT_FOUND);

    const { firstName, lastName, dob, email, address } = requestData;
    const hasIdentityChanges =
      firstName !== undefined ||
      lastName !== undefined ||
      dob !== undefined ||
      email !== undefined ||
      address !== undefined;

    // Goi LUON, ke ca khi request chi doi branch. Truoc day lan lookup nay
    // nam trong `if (hasIdentityChanges)`, nen duong "chi doi branch" khong
    // hoi shared-user lan nao va response tra ve `isActive` cua cot cuc bo -
    // luon `true`, ke ca voi tai khoan da bi khoa. Ngoai ra day van la ban
    // snapshot gia tri CU phuc vu rollback ben duoi.
    let beforeIdentity: Awaited<
      ReturnType<SharedUserServiceClient['lookupById']>
    > | null = null;
    try {
      beforeIdentity = await this.sharedUserServiceClient.lookupById(
        user.sharedUserId,
      );
    } catch (error) {
      this.logger.error(
        `Error snapshotting identity on shared-user before update: ${error.message}`,
        error.stack,
        context,
      );
      throw new AuthException(AuthValidation.ERROR_UPDATE_USER);
    }
    // Chi bat buoc phai co identity khi sap GHI sang shared-user (can gia tri
    // cu de rollback). Duong chi doi branch van chay tiep duoc voi
    // beforeIdentity = null: khi do mergeSharedUserIdentity se tra
    // `isActive: false`, dung voi 1 row khong con danh tinh ben shared-user.
    // 404 tu shared-user = khong co danh tinh nay -> bao dung "not found",
    // khong bao thanh loi ghi chung chung (architect-http.md muc 1.7).
    if (hasIdentityChanges && !beforeIdentity) {
      this.logger.error(
        `Shared-user identity not found for sharedUserId ${user.sharedUserId} before update`,
        null,
        context,
      );
      throw new AuthException(AuthValidation.USER_NOT_FOUND);
    }

    // Buoc 8.3: KHONG chep `requestData` xuong hang cuc bo nua - truoc day
    // `Object.assign(user, { ...requestData })` ghi ca ho ten / ngay sinh /
    // email / dia chi vao cot cuc bo (doi ten o 8.9). Hang cuc bo chi con
    // `branch` (ben duoi); identity ghi sang shared-user (`updateIdentity`).
    if (requestData.branch) {
      const branch = await this.branchRepository.findOne({
        where: { slug: requestData.branch },
      });
      if (!branch) {
        this.logger.warn(`Branch ${requestData.branch} not found`, context);
        throw new BranchException(BranchValidation.BRANCH_NOT_FOUND);
      }
      user.branch = branch;
    }

    // Buoc 8.3: KHONG con ghi `dobDM` cuc bo - ngay sinh chi o shared-user
    // (`updateIdentity` ben duoi), producer sinh nhat o shared-user (8.1).

    let identity: Awaited<
      ReturnType<SharedUserServiceClient['updateIdentity']>
    > | null = null;
    if (hasIdentityChanges) {
      try {
        identity = await this.sharedUserServiceClient.updateIdentity(
          user.sharedUserId,
          { firstName, lastName, dob, email, address },
        );
      } catch (error) {
        this.logger.error(
          `Error updating identity on shared-user: ${error.message}`,
          error.stack,
          context,
        );
        if (error?.response?.status === 409) {
          throw new AuthException(AuthValidation.USER_EXISTS);
        }
        throw new AuthException(AuthValidation.ERROR_UPDATE_USER);
      }
    }

    try {
      const updatedUser = await this.userRepository.save(user);
      this.logger.log(`User ${user.id} updated profile`, context);
      if (requestData.dob && this.isTodayBirthday(requestData.dob))
        this.eventEmitter.emit(CampaignAction.USER_BIRTHDAY_TRIGGERED, {
          user: updatedUser,
        });
      const dto = this.mapper.map(updatedUser, User, UserResponseDto);
      // Duong chi doi branch khong goi updateIdentity nen `identity` la null -
      // khi do dung ban snapshot vua lay o tren. Luon phai merge, vi
      // `isActive` cua dto la cot cuc bo (du lieu chet, luon `true`).
      return this.mergeSharedUserIdentity(dto, identity ?? beforeIdentity);
    } catch (error) {
      this.logger.error(
        `Error when updating user locally after shared-user identity update: ${error.message}`,
        error.stack,
        context,
      );
      if (identity && beforeIdentity) {
        await this.rollbackSharedUserIdentity(
          user.sharedUserId,
          {
            firstName: beforeIdentity.firstName,
            lastName: beforeIdentity.lastName,
            dob: beforeIdentity.dob,
            email: beforeIdentity.email,
            address: beforeIdentity.address,
          },
          { firstName, lastName, dob, email, address },
          context,
        );
      }
      throw new AuthException(AuthValidation.ERROR_UPDATE_USER);
    }
  }

  // Rollback (architect-http.md muc 1.2 buoc 3): goi lai updateIdentity voi
  // gia tri CU de bu tru khi buoc ghi cuc bo o trend that bai sau khi
  // shared-user da ghi thanh cong. Neu chinh lan goi rollback nay cung loi,
  // log o muc critical kem du context (sharedUserId, gia tri cu/moi that
  // bai) de xu ly thu cong - day la truong hop du lieu lech that su, khong
  // tu phuc hoi duoc.
  private async rollbackSharedUserIdentity(
    sharedUserId: string,
    oldValues: Record<string, unknown>,
    attemptedValues: Record<string, unknown>,
    context: string,
  ): Promise<void> {
    try {
      await this.sharedUserServiceClient.updateIdentity(
        sharedUserId,
        oldValues,
      );
      this.logger.warn(
        `Rolled back shared-user identity for sharedUserId ${sharedUserId} after local save failure`,
        context,
      );
    } catch (rollbackError) {
      this.logger.error(
        `CRITICAL: failed to rollback shared-user identity for sharedUserId ${sharedUserId} after local save failure - data is now OUT OF SYNC between trend and shared-user. Attempted new values: ${JSON.stringify(
          attemptedValues,
        )}. Intended rollback to: ${JSON.stringify(oldValues)}. Rollback error: ${rollbackError?.message}`,
        rollbackError?.stack,
        context,
      );
    }
  }

  async completeUserRegistration(
    userSlug: string,
    requestData: CompleteUserRegistrationRequestDto,
  ) {
    const context = `${UserService.name}.${this.completeUserRegistration.name}`;
    const user = await this.userRepository.findOne({
      where: { slug: userSlug },
    });
    if (!user) throw new UserException(UserValidation.USER_NOT_FOUND);

    // QD22 (buoc 2.5): requirement o shared-user. Doc qua `lookup`, khong doc
    // bang cuc bo nua. Fail-closed - khong tra loi duoc thi 503, khong duoc
    // doan la "khong co requirement" roi cho di tiep.
    const identity = await this.sharedUserServiceClient.lookupById(
      user.sharedUserId,
    );
    if (!identity) throw new UserException(UserValidation.USER_NOT_FOUND);

    const blockedPhonenumberRequirement = (
      identity.userRequirements ?? []
    ).find(
      (requirement) =>
        requirement.key === UserRequirementKey.NEED_UPDATE_PHONE_NUMBER &&
        requirement.status === UserRequirementStatus.PENDING &&
        requirement.level === UserRequirementLevel.BLOCK &&
        requirement.scope === UserRequirementScope.INITIAL,
    );

    // Ket qua that su cua lenh ghi xa - nguon de chep xuong cot guong.
    let updated: SharedUserLookupResponse | null = null;

    if (blockedPhonenumberRequirement) {
      // So voi SDT THAT ben shared-user (`identity`), KHONG so voi cot guong
      // cuc bo. Cot guong duoc phep cu (khach doi so o service khac, lop bu
      // chua chay) - so nham thi: cuc bo thay "co doi", shared-user thay
      // "khong doi" => no BO QUA ca khoi, requirement KHONG duoc COMPLETED,
      // ma client van nhan 204 "hoan tat thanh cong". Khach bi chan tiep ma
      // khong hieu vi sao.
      if (identity.phonenumber === requestData.phonenumber) {
        this.logger.warn(
          AuthValidation.NEED_UPDATE_PHONE_NUMBER.message,
          context,
        );
        throw new AuthException(AuthValidation.NEED_UPDATE_PHONE_NUMBER);
      } else {
        // Phonenumber la login key that su - thuoc ve shared-user
        // (architect-http.md muc 1.1). Ghi sang do TRUOC (fail-closed: neu
        // shared-user tu choi thi khong duoc luu ban cuc bo, tranh 2 ben lech
        // nhau). Buoc 8.3: bo phep tra trung "fast-fail" tren cot SDT cuc bo
        // (doi ten o 8.9) - shared-user la noi duy nhat biet so da co chu
        // chua, tra 409 => PHONE_NUMBER_ALREADY_EXISTS.
        try {
          updated = await this.sharedUserServiceClient.updateIdentity(
            user.sharedUserId,
            { phonenumber: requestData.phonenumber },
          );
        } catch (error) {
          this.logger.error(
            `Error updating phonenumber on shared-user: ${error.message}`,
            error.stack,
            context,
          );
          if (error?.response?.status === 409) {
            throw new AuthException(AuthValidation.PHONE_NUMBER_ALREADY_EXISTS);
          }
          throw new AuthException(
            AuthValidation.ERROR_COMPLETE_USER_REGISTRATION,
          );
        }
        // Ghi guong theo RESPONSE, khong theo `requestData`: chep dung cai
        // shared-user DA LUU, khong phai cai minh XIN luu.
        //
        // ⚠ Buoc 8.3 CO Y GIU lenh ghi guong nay (khong ai DOC cot nay nua tu
        // 8.2/8.3), vi cot `phonenumber_column` con NOT NULL + UNIQUE va hai
        // duong TAO hang (`createUser`, `UserProvisioningService`) con chep
        // SDT xuong do toi 8.8. Bo ghi o day thi khach doi so A -> B van giu
        // A o cot cuc bo; nguoi sau dang ky bang so A se vap UNIQUE khi tao
        // hang cuc bo (provision tra ERROR_CREATE_USER). Go cung luc voi hai
        // duong tao o 8.8 (migration 8.9 `MODIFY ... NULL` truoc khi doi ten).
        Object.assign(user, {
          phonenumber: updated.phonenumber,
        });
        // KHONG danh dau requirement o day nua (QD22, buoc 2.5):
        // `update-identity` cua shared-user tu chuyen
        // NEED_UPDATE_PHONE_NUMBER sang COMPLETED khi SDT doi - cung mot
        // transaction voi chinh phep doi SDT, nen khong con canh "doi SDT
        // xong ma requirement con PENDING".
      }
    }

    // QD22.d (buoc 2.5) - DA XOA hai khoi da comment ve khoa mat khau (doi mat
    // khau tai cho + nhanh "khong co requirement nao"). Chung chet tu truoc khi
    // tach service, va tu 2.5 thi khoa NEED_UPDATE_PASSWORD duoc go o luong
    // QUEN MAT KHAU ben shared-user (`auth.service.ts`), khong phai o day.
    if (!blockedPhonenumberRequirement) {
      this.logger.error(
        `User ${user.slug} has no blocked phone number requirement`,
        context,
      );
      throw new AuthException(
        AuthValidation.USER_NOT_HAVE_BLOCKED_PHONE_NUMBER_REQUIREMENT,
      );
    }

    // Truoc day cho nay tu bat lai `user.isActive = true` khi user hoan tat
    // dang ky. Da go (2026-09-04): tu dot "khoa tai khoan quy han ve
    // shared-user" (architect-http.md muc 1.1), cot cuc bo nay khong con ai
    // doc, va viec ghi vao no KHONG mo khoa tai khoan that - trang thai that
    // nam ben shared-user. Nghia la doan code do da khong con tac dung ke tu
    // dot cutover, chi con lam ban mot cot sap bi drop o giai doan 2.
    //
    // Neu nghiep vu THAT SU can "hoan tat dang ky thi mo khoa lai tai
    // khoan", phai lam bang mot duong ghi sang shared-user va tuan theo muc
    // 1.2 (ghi shared-user truoc, rollback neu ghi cuc bo hong) - hien
    // `POST /internal/users/:id/update-identity` khong nhan `isActive`, nen
    // day la viec can quyet dinh rieng, khong phai sua tien tay o day. Xem
    // progress/trend-api.md muc "Bo sung (2026-09-04)".

    // Ghi guong. Hong thi KHONG bu tru lui (doi tu buoc 2.5).
    await this.transactionManagerService.execute<void>(
      async (manager) => {
        // Chi con hang `user` cuc bo (cot `phonenumber` con song toi GD8).
        // Requirement da do shared-user tu dong trong `update-identity`.
        await manager.save(user);
      },
      () => {
        this.logger.log(
          `User ${user.slug} registration has been completed`,
          context,
        );
      },
      (error) => {
        // KHONG nem - ca chu dich, khong phai bo sot.
        // `TransactionManagerService.execute` da rollback truoc khi goi callback
        // nay va CHI nem tiep neu callback nem. Khong nem nghia la: guong khong
        // ghi duoc, nhung request van THANH CONG (204).
        //
        // Vi sao khong bu tru ve shared-user:
        // - Lenh ghi duy nhat o day la cot `phonenumber_column` cuc bo - mot
        //   GUONG cua shared-user, song toi GD8 (doi ten 8.9, drop 10.3). Su
        //   that DA ghi dung: khach that su da doi SDT, va requirement da
        //   COMPLETED trong cung transaction do ben shared-user.
        // - SAI huong: huy mot lenh ghi da thanh cong vao nguon su that chi vi
        //   cap nhat guong hong;
        // - KHONG DU: `update-identity` con mot hieu ung phu la dat requirement
        //   ve COMPLETED, ma lenh bu tru (chi ghi lai phonenumber) khong mo lai
        //   duoc - bu tru xong van lech;
        // - DAP LEN NGUOI KHAC: giua luc ta ghi va luc ta bu tru, mot luot khac
        //   co the da doi SDT sang gia tri thu ba; ghi de "gia tri cu" len do la
        //   lost update tren chinh du lieu dang nhap.
        //
        // ⚠ GUONG KHONG TU SUA. Do lai 31/10/2026:
        // `UserProvisioningService.provisionLocalUser` thoat som khi hang da ton
        // tai (`if (existed) return`), nen lop 1 (sync-on-read) va lop 3 (cron)
        // cua QD19 CHI TAO hang thieu, KHONG cap nhat hang cu. Khong co lop nao
        // keo cot nay ve - no lech cho toi khi GD8 drop cot.
        //
        // Hau qua thuc te (do lai buoc 8.3): KHONG con cho nao DOC cot nay - tim
        // theo SDT (`GET /user?phonenumber=`) hoi shared-user tu 8.2, tra trung
        // khi tao hoi shared-user tu 8.3; response nao cung ghep identity tu
        // shared-user. Con lai MOT rui ro: rang buoc UNIQUE - so CU con nam o
        // hang nay, nguoi sau dang ky bang so do se vap UNIQUE khi tao hang
        // cuc bo. Het khi 8.8 thoi ghi cot, 8.9 doi ten.
        this.logger.error(
          `[MIRROR-LAG] local phonenumber mirror NOT written for ${user.slug} (shared-user already stored ${updated?.phonenumber}); the old number stays in the UNIQUE local column until stage 8.8: ${error?.message}`,
          error?.stack,
          context,
        );
      },
    );
  }

  // Tao user moi: trend quyet dinh role/branch (nghiep vu cua no), sau do
  // goi noi bo sang shared-user de luu lai identity (phonenumber, mat khau,
  // ho ten...) - dao nguoc thu tu so voi truoc khi tach (khi do trend tu
  // luu het). Validate role/branch truoc khi goi sang shared-user de khong
  // tao "rac" ben do neu request sai ngay tu dau; trung SDT do shared-user
  // bao (buoc 8.3).
  async createUser(requestData: CreateUserRequestDto) {
    const context = `${UserService.name}.${this.createUser.name}`;

    const role = await this.roleRepository.findOne({
      where: { slug: requestData.role },
    });
    if (!role) throw new RoleException(RoleValidation.ROLE_NOT_FOUND);

    let branch: Branch | undefined;
    if (requestData.branch) {
      branch = await this.branchRepository.findOne({
        where: { slug: requestData.branch },
      });
      if (!branch) throw new BranchException(BranchValidation.BRANCH_NOT_FOUND);
    }

    // Buoc 8.3: KHONG tra trung SDT tren cot cuc bo nua (doi ten o 8.9; ban
    // guong co the cu). shared-user tu bao trung khi tao (400 `USER_EXISTS`
    // / 409) => `USER_EXISTS` o nhanh catch ben duoi - mot nguon su that.
    let sharedUser: Awaited<ReturnType<SharedUserServiceClient['createUser']>>;
    try {
      sharedUser = await this.sharedUserServiceClient.createUser({
        phonenumber: requestData.phonenumber,
        password: requestData.password,
        firstName: requestData.firstName,
        lastName: requestData.lastName,
        dob: requestData.dob,
        isVerifiedPhonenumber: requestData.isVerifiedPhonenumber,
        // ==================================================================
        // QD18 - DAY LA CHO DUY NHAT `trend` DICH ROLE CUA NO THANH CO
        // TRUNG TINH. Giu no o mot cho, dung rai.
        //
        // `trend` khai bao: role dung chung cua no la `Customer`. Moi role
        // khac la nhan vien/hang he thong => rieng cua trend.
        //
        // Cot dich (`owner_service`) la cot BAT BIEN, khong co duong thang
        // 'trend' -> NULL. Gui `false` nham cho mot khach that la khoa cung
        // ho vao rieng trend VINH VIEN. Xem architect-http.md muc 1.1 quy
        // tac 6.
        // ==================================================================
        isShared: role.name === RoleEnum.Customer,
      });
    } catch (error) {
      this.logger.error(
        `Error when creating identity on shared-user: ${error.message}`,
        error.stack,
        context,
      );
      if (error?.response?.status === 400 || error?.response?.status === 409) {
        throw new AuthException(AuthValidation.USER_EXISTS);
      }
      throw error;
    }

    // QD19 - UPSERT, khong phai insert thuan. Giua hai buoc cua chinh lenh
    // nay (tao identity o tren, luu hang cuc bo o duoi), lop 1 (sync-on-read)
    // hoac lop 3 (cron) co the da keo dung nguoi vua tao ve va ghi mot hang
    // cuc bo voi role `Customer` mac dinh. Insert thuan se vap unique
    // constraint va bao loi cho nguoi bam nut - trong khi that ra moi thu
    // deu on.
    //
    // `provisionedByAnotherLayer` con dung o nhanh rollback: neu hang cuc bo
    // do LOP KHAC tao chu khong phai lenh nay, thi huy danh tinh la SAI -
    // chi huy khi chinh lenh nay vua tao ra no (muc 1.2).
    const existedLocalUser = await this.userRepository.findOne({
      where: { sharedUserId: sharedUser.id },
    });
    const provisionedByAnotherLayer = !!existedLocalUser;

    const user =
      existedLocalUser ??
      this.userRepository.create({
        phonenumber: sharedUser.phonenumber,
        sharedUserId: sharedUser.id,
      });
    // Y dinh cua lenh tao thang ban role mac dinh ma lop khac vua gan.
    user.role = role;
    user.branch = branch;

    try {
      const createdUser = await this.userRepository.save(user);
      this.logger.log(`User has been created successfully`, context);
      const dto = this.mapper.map(createdUser, User, UserResponseDto);
      // Ghep identity tu chinh response tao user ben shared-user - row cuc
      // bo chi luu {phonenumber, sharedUserId, role, branch}, khong luu
      // firstName/lastName/... nen phai lay tu day, khong the map tu entity
      // cuc bo (se rong) (architect-http.md muc 1.1 quy tac 4).
      return this.mergeSharedUserIdentity(dto, sharedUser);
    } catch (error) {
      this.logger.error(
        `Error when saving local user: ${error.message}`,
        error.stack,
        context,
      );
      // Rollback (architect-http.md muc 1.2 buoc 3): identity da duoc tao
      // ben shared-user o tren, buoc ghi cuc bo vua that bai - phai bu tru
      // ngay, khong duoc de lai trang thai "shared-user da tao nhung trend
      // bao loi". Neu khong bu tru, so dien thoai do bi giu vinh vien ben
      // shared-user va admin khong bao gio tao lai duoc user nay (lan sau
      // se dinh USER_EXISTS tu chinh shared-user).
      if (provisionedByAnotherLayer) {
        // Hang cuc bo do LOP KHAC cua QD19 tao ra, khong phai lenh nay -
        // huy danh tinh o shared-user la xoa mat mot nguoi dung that. Chi
        // bao loi, khong bu tru.
        this.logger.warn(
          `Local user for sharedUserId=${sharedUser.id} was provisioned by another layer; skip identity rollback`,
          context,
        );
      } else {
        await this.rollbackSharedUserCreate(
          sharedUser.id,
          requestData.phonenumber,
          context,
        );
      }
      throw new UserException(UserValidation.ERROR_CREATE_USER);
    }
  }

  // Rollback (architect-http.md muc 1.2 buoc 3) cho duong TAO user - khac
  // rollbackSharedUserIdentity o cho khong co "gia tri cu" de ghi de, vi
  // truoc buoc tao thi ben shared-user chua co gi. Bu tru dung nghia o day
  // la huy identity vua tao (tra lai so dien thoai + tat isActive).
  //
  // Neu chinh lan bu tru nay cung loi, log critical kem du context de xu ly
  // thu cong - dung muc 1.2 buoc 4.
  private async rollbackSharedUserCreate(
    sharedUserId: string,
    phonenumber: string,
    context: string,
  ): Promise<void> {
    try {
      await this.sharedUserServiceClient.revertCreatedUser(sharedUserId);
      this.logger.warn(
        `Rolled back shared-user identity ${sharedUserId} after local save failure`,
        context,
      );
    } catch (rollbackError) {
      this.logger.error(
        `CRITICAL: failed to roll back shared-user identity ${sharedUserId} (phonenumber ${phonenumber}) after local save failure - the identity now EXISTS on shared-user with no matching row on trend. Manual cleanup required (revert or delete it) before this phonenumber can be used again. Rollback error: ${rollbackError?.message}`,
        rollbackError?.stack,
        context,
      );
    }
  }

  // Gan role cho 1 user da co hang cuc bo o trend. Nhan `slug` CUC BO (giong
  // `terminal`) - UI lay slug thang tu danh sach no da co. Ban truoc tra hang
  // cuc bo theo `phonenumber` trong body: trai muc 1.6 quy tac 3
  // (architect-http.md) - cot identity sap drop o giai doan 8 va co the lech
  // voi shared-user.
  //
  // QD20 - Customer la role DONG, chan du BA duong:
  //   1. Customer -> nhan vien: CANNOT_UPDATE_CUSTOMER_ROLE;
  //   2. role dich = Customer: CANNOT_ASSIGN_CUSTOMER_ROLE (137006), xet NGAY
  //      sau khi tra role, TRUOC khi nhin hang cuc bo - ket qua khong duoc
  //      phu thuoc hang cuc bo da co hay chua;
  //   3. chua co hang cuc bo: tra theo slug cuc bo thi khong co hang = khong
  //      co slug => USER_NOT_FOUND. Khong con duong nao tu tao hang voi role
  //      dich o day (ban cu lam vay => race voi lop 1/3 cua QD19).
  // Nhan vien moi di duong `POST /user` (createUser), khong di duong nay.
  async updateUserRole(slug: string, requestData: UpdateUserRoleRequestDto) {
    const context = `${UserService.name}.${this.updateUserRole.name}`;
    const role = await this.roleRepository.findOne({
      where: {
        slug: requestData.role,
      },
    });
    if (!role) throw new RoleException(RoleValidation.ROLE_NOT_FOUND);

    if (role.name === RoleEnum.Customer) {
      this.logger.warn(`Can not assign ${role.name} role`, context);
      throw new UserException(UserValidation.CANNOT_ASSIGN_CUSTOMER_ROLE);
    }

    const user = await this.userRepository.findOne({
      where: { slug },
      relations: ['role'],
    });
    if (!user) throw new UserException(UserValidation.USER_NOT_FOUND);

    if (user.role?.name === RoleEnum.Customer) {
      this.logger.warn(
        `Can not update customer role to ${role.name} role`,
        context,
      );
      throw new UserException(UserValidation.CANNOT_UPDATE_CUSTOMER_ROLE);
    }

    // Tra theo `id` (architect-http.md muc 1.3) - `id` la khoa chinh that, on
    // dinh hon `phonenumber` (co the doi qua completeUserRegistration).
    const sharedUser = await this.sharedUserServiceClient.lookupById(
      user.sharedUserId,
    );
    if (!sharedUser) throw new UserException(UserValidation.USER_NOT_FOUND);

    try {
      user.role = role;
      await this.userRepository.save(user);
      this.logger.log(`User role has been updated successfully`, context);
    } catch (error) {
      this.logger.error(
        `Error when updating user role: ${error.message}`,
        error.stack,
        context,
      );
      throw error;
    }

    const dto = this.mapper.map(user, User, UserResponseDto);
    // Ghep identity - row cuc bo khong phai nguon identity (muc 1.6), phai
    // lay firstName/lastName/... tu lan lookup vua goi o tren (khong
    // goi lai lan 2) (architect-http.md muc 1.1 quy tac 4).
    return this.mergeSharedUserIdentity(dto, sharedUser);
  }

  /**
   * QD19 LOP 1 - sync-on-read.
   *
   * Keo user tao ben `shared-user` trong 15 phut gan nhat ve va tao hang cuc
   * bo cho ai chua co, **truoc khi** chay truy van cuc bo.
   *
   * ### Vi sao phai co, noi cho dung
   * `getAllUsers` chi doc `user_tbl` cuc bo. Khach tu dang ky qua
   * `shared-user` ma chua tung dang nhap vao `trend` thi **nhan vien tra
   * khong ra**. Va o day khong phai "man hinh xem cho vui": chinh
   * `getAllUsers` la thu bon O TIM KHACH dang dung (gio hang ban tai quay,
   * thanh toan, nguoi nhan the qua, cac dialog gan the/nhom khach). Va lop 3
   * la cron, tot nhat cung tre 10 phut - day la nhip bu cho khe do.
   *
   * ### Bon dieu kien, thieu cai nao cung hong
   *
   * 1. **THROTTLE 60 GIAY - quan trong hon ca timeout.** O tim khach co
   *    debounce: go mot so dien thoai van ra 3-5 luot goi, nhan voi nhieu
   *    may o quay gio cao diem la mot dong request deu dan chi de nghe
   *    "khong co ai moi". `SET NX EX` tren Redis => dung 1 luot/60 giay cho
   *    TOAN CUM. Cua so 15 phut van thua suc phu.
   * 2. **Timeout ngan.** Day la duong nguoi dung dang cho go, khong phai
   *    lenh goi nen - 2 giay la tran.
   * 3. **FAIL-OPEN.** Goi hong/timeout => bo qua, tra ket qua cuc bo, log
   *    `warn`. KHONG nem loi len.
   * 4. **Dung lai `ensureLocalUser`** (khong viet vong insert thu hai) va
   *    **loc `ownerService`** (khong keo nhan vien cua service khac ve).
   *
   * > ### Muc 3 la NGOAI LE CO CHU DICH cua muc 1.7
   * > Moi duong khac quy loi `shared-user` thanh **503**. Cho nay co y
   * > khong, vi no chi la nhip bu them, khong phai nguon du lieu chinh cua
   * > response. **Ghi ro de lan ra sau khong ai "sua cho nhat quan".**
   *
   * Mot tinh chat tot, dang ghi: dong bo **theo thoi gian tao**, khong theo
   * chuoi dang tim. Nen go nham so **khong de ra hang rac** - khac han
   * phuong an "tim thay ai thi tao ho so nguoi do".
   */
  private async syncRecentSharedUsersOnRead(): Promise<void> {
    const context = `${UserService.name}.${this.syncRecentSharedUsersOnRead.name}`;
    try {
      const redis = await this.distributeLockJobQueue.client;
      // `SET NX EX` la mot lenh nguyen tu: ai set duoc thi nguoi do chay.
      // Co tinh KHONG dung chung khoa Redlock voi cron (QD21) - dung chung
      // thi lop 1 chan duoc cron va nguoc lai, bien hai co che doc lap
      // thanh phu thuoc nhau, va luc dieu tra su co se khong con suy luan
      // duoc "ai da chay, ai bi bo". Chay trung vai luot la VO HAI
      // (idempotent) - re hon nhieu so voi mot co che khu trung kho hieu.
      const acquired = await redis.set(
        SYNC_RECENT_USERS_THROTTLE_KEY,
        '1',
        'EX',
        SYNC_RECENT_USERS_THROTTLE_SECONDS,
        'NX',
      );
      if (!acquired) return;

      const now = new Date();
      const from = new Date(
        now.getTime() - SYNC_RECENT_USERS_WINDOW_MINUTES * 60 * 1000,
      );
      const recent = await this.sharedUserServiceClient.listRecent(from, now, {
        timeout: SYNC_RECENT_USERS_TIMEOUT_MS,
      });
      if (!recent.length) return;

      const { created, skippedForeign } =
        await this.userProvisioningService.ensureLocalUsers(recent);
      if (created || skippedForeign) {
        this.logger.log(
          `Sync-on-read provisioned ${created} local user(s), skipped ${skippedForeign} owned by another service`,
          context,
        );
      }
    } catch (error) {
      // FAIL-OPEN co chu dich - xem ghi chu tren dau ham.
      this.logger.warn(
        `Sync-on-read skipped, falling back to local data only: ${error.message}`,
        context,
      );
    }
  }

  /**
   * QD19 LOP 1b - tra DUNG SDT khi tim cuc bo ra rong.
   *
   * Tra `true` khi da co hang cuc bo khop dung so vua go (ben goi truy van
   * lai), `false` o moi truong hop con lai.
   *
   * ### Vi sao phai co, khi da co sync-on-read
   * Sync-on-read chon nguoi **theo thoi gian** va bi throttle 60 giay toan
   * cum, nen van co khe: khach vua dang ky tren app, ra quay ngay, nhan vien
   * go so dung luc luot sync bi throttle (hoac `list-recent` timeout) => rong.
   * Nhan vien bam "Tao khach moi" thi `POST /user` bao `USER_EXISTS` vi so da
   * co ben shared-user - ket o ca hai dau. Day la thao tac o quay tan suat
   * cao nhat, nen ham nay tra **dung nguoi dang can**, khong phu thuoc
   * throttle hay cua so.
   *
   * ### Dieu kien, thieu cai nao cung hong
   *
   * 1. **Chi khi rong va go DU so** (`LOOKUP_ON_MISS_PHONENUMBER_PATTERN`).
   *    Co ket qua => khong goi gi. Go do dang => khong goi. Khop TUYET DOI
   *    nen go nham khong de ra hang rac.
   * 2. **Loc role cua request phai chua `Customer`** (neu co loc): hang moi
   *    luon la Customer, truy van lai voi loc role khac cung khong ra.
   * 3. **Timeout ngan, FAIL-OPEN** - cung ngoai le co chu dich cua muc 1.7
   *    nhu sync-on-read: loi => tra ket qua cuc bo (rong), log `warn`.
   * 4. **Loc `ownerService`** (QD18) truoc, roi **dung lai `ensureLocalUser`**
   *    - khong viet vong insert thu hai.
   *
   * KHONG throttle: no chi chay khi rong + du so, moi luot la mot lookup
   * khop tuyet doi theo khoa. Throttle o day lai mo lai dung khe dang va.
   */
  /**
   * Trang rong dung shape cua `getAllUsers` - dung khi loc theo ma the mà
   * khong co the nao mang ma do (QD22.a, buoc 2.5).
   */
  private emptyUserPage(
    query: GetAllUserQueryRequestDto,
  ): AppPaginatedResponseDto<UserResponseDto> {
    const page = query.hasPaging ? query.page : 1;
    return {
      hasNext: false,
      hasPrevios: false,
      items: [],
      total: 0,
      page,
      pageSize: query.hasPaging ? query.size : 0,
      totalPages: 0,
    } as AppPaginatedResponseDto<UserResponseDto>;
  }

  /**
   * Cap hang cuc bo cho mot `sharedUserId` truoc khi loc theo no (QD22.a).
   * The dung chung giua hai order service, nen chu the co the chua tung dang
   * nhap vao trend => chua co hang cuc bo => loc ra rong oan.
   *
   * Fail-open: cap hang khong duoc thi cu loc tiep (ra rong) - dung nhu khi
   * chua co hang. Khong nem, vi day la duong doc va `GET /user` con cho
   * nhan vien tim nguoi khac.
   */
  private async provisionLocalUserForSharedId(
    sharedUserId: string,
  ): Promise<void> {
    const context = `${UserService.name}.${this.provisionLocalUserForSharedId.name}`;
    try {
      const existed = await this.userRepository.findOne({
        where: { sharedUserId },
        select: { id: true },
      });
      if (existed) return;

      const sharedUser =
        await this.sharedUserServiceClient.lookupById(sharedUserId);
      if (!sharedUser) return;
      if (
        !this.userProvisioningService.isProvisionable(sharedUser.ownerService)
      )
        return;
      await this.userProvisioningService.ensureLocalUser(sharedUser);
      this.logger.log(
        `Ensured local user for membership-card holder sharedUserId=${sharedUserId}`,
        context,
      );
    } catch (error) {
      this.logger.warn(
        `Could not ensure local user for membership-card holder sharedUserId=${sharedUserId}: ${error?.message}`,
        context,
      );
    }
  }

  private async provisionByExactPhonenumberOnMiss(
    query: GetAllUserQueryRequestDto,
  ): Promise<boolean> {
    const context = `${UserService.name}.${this.provisionByExactPhonenumberOnMiss.name}`;

    const phonenumber = query.phonenumber?.trim();
    if (!phonenumber || !LOOKUP_ON_MISS_PHONENUMBER_PATTERN.test(phonenumber))
      return false;
    if (!_.isEmpty(query.role) && !query.role.includes(RoleEnum.Customer))
      return false;

    try {
      const sharedUser = await this.sharedUserServiceClient.lookupByPhonenumber(
        phonenumber,
        { timeout: LOOKUP_ON_MISS_TIMEOUT_MS },
      );
      if (!sharedUser) return false;
      if (!this.userProvisioningService.isProvisionable(sharedUser.ownerService))
        return false;

      await this.userProvisioningService.ensureLocalUser(sharedUser);

      // Buoc 8.3: bo phep so SDT cua hang cuc bo voi SDT that. Tu 8.2 bo loc
      // SDT cua `GET /user` hoi shared-user (`search-by-phonenumber`) roi loc
      // theo `sharedUserId`, nen guong SDT cuc bo cu khong con lam truy van
      // lai ra rong - va cot do doi ten o 8.9.
      this.logger.log(
        `Lookup-on-miss ensured local user for sharedUserId=${sharedUser.id}`,
        context,
      );
      return true;
    } catch (error) {
      // FAIL-OPEN co chu dich - xem ghi chu tren dau ham.
      this.logger.warn(
        `Lookup-on-miss skipped, falling back to local data only: ${error.message}`,
        context,
      );
      return false;
    }
  }

  // Doi loi cua lenh GHI `resetPassword` / `toggleActive` sang loi ma
  // `HttpExceptionFilter` bat duoc. Client co tinh KHONG boc hai lenh nay qua
  // `toReadError`, nen neu nem nguyen loi axios thi no roi xuong bo xu ly mac
  // dinh cua Nest va ra 500.
  //
  // `shared-user` bao "khong co user" bang HTTP 400 kem ma nghiep vu 137000
  // trong body (AppException mac dinh 400), khong phai 404 - nen phai doc ma
  // trong body. 404 giu lai phong khi ben kia doi sang tra dung status. Moi
  // thu khac = shared-user khong thi hanh duoc lenh => 503.
  private toSharedUserCommandError(error: unknown, context: string): never {
    const response = (
      error as {
        response?: { status?: number; data?: { statusCode?: number } };
      }
    )?.response;
    if (
      response?.status === 404 ||
      response?.data?.statusCode === SHARED_USER_USER_NOT_FOUND_CODE
    ) {
      throw new UserException(UserValidation.USER_NOT_FOUND);
    }
    this.logger.error(
      `shared-user command failed: ${(error as Error)?.message}`,
      (error as Error)?.stack,
      context,
    );
    throw new SharedUserUnavailableException();
  }

  /**
   * QD16 - dat lai mat khau cho mot tai khoan, va **cua kiem quyen dat o day**.
   *
   * ### Vi sao route nay o `trend` chu khong o `shared-user`
   *
   * *Dat lai mat khau can quyen cua NGUOI RA QUYET DINH, ma quyen do nam o
   * `trend`.* Ai duoc phep dat lai mat khau cua nguoi khac la cau hoi ve
   * **chuc vu trong cua hang** (Manager/Admin/SuperAdmin) - du kien ay chi
   * `trend` giu dung. De `shared-user` tu tra loi la bat no doan bang mot ban
   * role khong ai cap nhat, va do chinh la co che sinh ra **R1**: admin vua
   * duoc cap quyen qua `POST {trend}/user/role` bi **403 oan**.
   *
   * Nhan `slug` CUC BO cua `trend` - UI lay thang tu danh sach no da co. Day
   * cung la thu xoa han **R6**: truoc day UI phai tra nguoc slug that ben
   * `shared-user` bang `GET /user?phonenumber=`, ma route do khop CHUOI CON.
   */
  async resetPasswordForUser(slug: string) {
    const context = `${UserService.name}.${this.resetPasswordForUser.name}`;
    const user = await this.userRepository.findOne({ where: { slug } });
    if (!user) throw new UserException(UserValidation.USER_NOT_FOUND);

    try {
      await this.sharedUserServiceClient.resetPassword(user.sharedUserId);
    } catch (error) {
      this.toSharedUserCommandError(error, context);
    }
    this.logger.log(
      `Password reset requested for user ${slug} (sharedUserId=${user.sharedUserId})`,
      context,
    );
  }

  /**
   * QD16 - khoa/mo khoa tai khoan. Cung ly do dat cua kiem quyen o day nhu
   * `resetPasswordForUser`.
   *
   * > ### Day KHONG phai dao nguoc quyet dinh xoa route `toggle-active` cu
   * > Route cu cua `trend` bi xoa vi no thao tac tren **cot `isActive` cuc bo
   * > cua `trend`** - hai ban trang thai khong dong bo. Route nay **khong ghi
   * > cot nao cua `trend`**: no doc trang thai hien tai TU `shared-user`, dao,
   * > roi gui gia tri DICH sang `shared-user`. Trang thai khoa van chi co
   * > **mot nguon that** la `shared_user_db`.
   *
   * Doc-roi-ghi chu khong goi mot lenh "toggle" o ben kia la co y: route noi
   * bo nhan gia tri dich nen goi lai hai lan ra cung ket qua.
   */
  async toggleActiveUser(slug: string) {
    const context = `${UserService.name}.${this.toggleActiveUser.name}`;
    const user = await this.userRepository.findOne({ where: { slug } });
    if (!user) throw new UserException(UserValidation.USER_NOT_FOUND);

    const sharedUser = await this.sharedUserServiceClient.lookupById(
      user.sharedUserId,
    );
    if (!sharedUser) throw new UserException(UserValidation.USER_NOT_FOUND);

    let updated: SharedUserLookupResponse;
    try {
      updated = await this.sharedUserServiceClient.toggleActive(
        user.sharedUserId,
        !sharedUser.isActive,
      );
    } catch (error) {
      this.toSharedUserCommandError(error, context);
    }
    this.logger.log(
      `User ${slug} active status set to ${updated.isActive}`,
      context,
    );

    const dto = this.mapper.map(user, User, UserResponseDto);
    return this.mergeSharedUserIdentity(dto, updated);
  }

  /**
   * QD16-bis - duong tra NGUOI NHAN the qua, danh cho tai khoan `Customer`.
   *
   * ### Vi sao co ham nay
   *
   * `GET /user` truoc day **khong co `@HasRoles`** nen bat ky tai khoan dang
   * nhap nao, ke ca `Customer`, cung list duoc toan bo khach kem SDT / ho ten
   * / email. Do 12/09/2026: mot tai khoan khach that goi ra **200 + 916
   * khach**. Nay route do da gac, va **khong nhan `Customer`**.
   *
   * Nhung man KHACH co mot nhu cau that: mua the qua **tang cho nguoi khac**
   * thi phai tra duoc nguoi nhan theo SDT. Nen tach mot duong HEP rieng thay
   * vi noi rong lai cai route quan tri.
   *
   * ### Bon rang buoc, moi cai dong mot thu
   *
   * 1. **Khop TUYET DOI, khong khop chuoi con** - khop chuoi con chinh la rui
   *    ro **R6**. Khong mo lai no o mot cua khac.
   * 2. **Hoi `shared-user` truoc, khong tra cot `phonenumber` cuc bo** (muc
   *    1.3 uu tien `id` + muc 1.6 khong them cho DOC moi vao cot identity cuc
   *    bo). `lookup` cua `shared-user` von da khop tuyet doi.
   * 3. **Toi da MOT nguoi, toi thieu field** - chi `slug` + `phonenumber` + ho
   *    ten. KHONG email / dob / address / role / diem / vi.
   * 4. **Loc ba loai khong phai nguoi nhan hop le:** hang sentinel khach vang
   *    lai, danh tinh **thuoc service khac** (QD18), va nguoi khong phai
   *    `Customer` o `trend`.
   *
   * ### Co tinh KHONG tao hang cuc bo o day
   *
   * Day la duong DOC ma nguoi goi co the la `Customer` - cho no tao hang la
   * dua cho tai khoan quyen thap nhat mot don bay GHI. Nguoi dang ky o
   * `shared-user` da duoc **QD19 lop 1 + lop 3** keo ve trong <= 10 phut, nen
   * khe bo sot rat hep. Chua co hang cuc bo => tra rong.
   *
   * KHAC lop 1b (`provisionByExactPhonenumberOnMiss` trong getAllUsers): o do
   * duoc tao hang vi route `GET /user` da gac, nguoi goi chac chan la nhan
   * vien. Dung "sua cho nhat quan" hai cho nay.
   */
  async lookupRecipient(
    query: LookupRecipientQueryRequestDto,
  ): Promise<RecipientResponseDto[]> {
    const context = `${UserService.name}.${this.lookupRecipient.name}`;

    // Rang buoc 2: hoi shared-user, khop tuyet doi. Loi mang o day van ra 503
    // theo muc 1.7 - day KHONG phai duong co ngoai le fail-open nhu
    // sync-on-read, vi ket qua chinh cua response den tu lenh goi nay.
    const sharedUser = await this.sharedUserServiceClient.lookupByPhonenumber(
      query.phonenumber,
    );
    if (!sharedUser) return [];

    // Rang buoc 4a: sentinel khach vang lai khong phai mot con nguoi.
    //
    // So THANG voi hang so, khong goi `isDefaultCustomer`: doi tuong o day la
    // danh tinh lay tu `shared-user` - khoa cua no la `id`, khong co
    // `sharedUserId`. Dua no vao helper thi helper doc `sharedUser.sharedUserId`
    // (field khong ton tai) va NEM LOI (buoc 2.6, 2.7).
    if (sharedUser.id === DEFAULT_CUSTOMER_SHARED_ID) {
      this.logger.warn(
        `Recipient lookup hit the walk-in sentinel, ignored`,
        context,
      );
      return [];
    }

    // Rang buoc 4b: QD18 - danh tinh rieng cua service khac khong duoc lo ra
    // o day, y het cho khong duoc tu cap hang cuc bo.
    if (!this.userProvisioningService.isProvisionable(sharedUser.ownerService))
      return [];

    const local = await this.userRepository.findOne({
      where: { sharedUserId: sharedUser.id },
      relations: ['role'],
    });
    // Chua co ho so o `trend` => coi nhu khong tim thay.
    if (!local) return [];

    // Rang buoc 4c: chi khach moi nhan the qua qua duong nay.
    if (local.role?.name !== RoleEnum.Customer) return [];

    return [
      {
        slug: local.slug,
        phonenumber: sharedUser.phonenumber,
        firstName: sharedUser.firstName,
        lastName: sharedUser.lastName,
      },
    ];
  }

  /**
   * Buoc 8.1 (QD13) - route POST /user/birthday/trigger. Scheduler sinh nhat
   * nay o shared-user: route chi kich producer ben do chay mot luot (day job
   * `user-birthday-triggered` vao queue cua trend); cap thuong va gui loi
   * chuc do `UserBirthdayConsumer` lam sau, bat dong bo. shared-user khong tra
   * loi => 503 (`toReadError`).
   * @returns cau bao cho nguoi bam nut.
   */
  async triggerBirthdayProducer(): Promise<string> {
    const context = `${UserService.name}.${this.triggerBirthdayProducer.name}`;
    const run = await this.sharedUserServiceClient.triggerBirthdayProducer();
    if (!run?.enabled) {
      this.logger.warn(
        `Birthday producer of shared-user is off (USER_BIRTHDAY_QUEUE_PREFIX not set), nothing enqueued`,
        context,
      );
      return 'Birthday producer of shared-user is off, nothing was enqueued';
    }
    this.logger.log(
      `Birthday producer of shared-user ran: ${run.enqueued ?? 0}/${run.users ?? 0} job(s) for ${run.birthdayDM}${run.failed ? ' (failed part way)' : ''}`,
      context,
    );
    if (run.failed) {
      // Thuong gap nhat: mot luot khac (cron 17h hoac lan bam truoc trong 2
      // phut) con giu khoa Redlock ben shared-user.
      return `Birthday producer of shared-user did not finish (another run may hold its lock, try again in a few minutes): ${run.enqueued ?? 0} user(s) enqueued`;
    }
    return `Birthday producer has been triggered: ${run.enqueued ?? 0} user(s) enqueued`;
  }

  /**
   * Buoc 8.2 - bo loc identity cua danh sach user (SDT chuoi con, khoang ngay
   * sinh) loc TRUOC o shared-user: tra mang `sharedUserId` de ben goi loc
   * `sharedUserId IN (...)`. Cot SDT / ngay sinh cuc bo bi doi ten o 8.9, va loc
   * truoc (khong loc sau khi ghep) giu phan trang o DB dung.
   * - `null` = khong co bo loc identity nao; co ca hai => giao hai mang.
   * - Vuot tran => 400 (137007 / 137008, "tim hep lai", khong cat bot);
   *   shared-user khong tra loi => 503 (fail-closed: day la bo loc chinh cua
   *   response, roi ve cot cuc bo la sai lech D9). Cung khuon QD4 cua 7.1.
   */
  private async searchSharedUserIdsForFilter(filter: {
    phonenumber?: string;
    dob?: { type: DobFilterType; from?: string; to?: string };
  }): Promise<string[] | null> {
    const fragment = filter.phonenumber?.trim();
    const dob = filter.dob?.from || filter.dob?.to ? filter.dob : undefined;
    if (!fragment && !dob) return null;
    const byPhonenumber = fragment
      ? await this.sharedUserServiceClient.searchIdsByPhonenumber(fragment)
      : null;
    const byBirthday = dob
      ? await this.sharedUserServiceClient.searchIdsByBirthday(dob)
      : null;
    if (byPhonenumber && byBirthday) {
      const inRange = new Set(byBirthday);
      return byPhonenumber.filter((id) => inRange.has(id));
    }
    return byPhonenumber ?? byBirthday;
  }

  async getAllUsers(
    query: GetAllUserQueryRequestDto,
  ): Promise<AppPaginatedResponseDto<UserResponseDto>> {
    // QD19 lop 1. Phai `await` XONG roi moi truy van - khong thi hang vua
    // ghi chua nhin thay duoc va ca nhip bu thanh vo nghia o chinh luot goi
    // nay. Va co tinh KHONG boc chung transaction voi truy van doc ben
    // duoi: ghi phai commit doc lap, boc chung la giu khoa suot thoi gian
    // cho mang.
    await this.syncRecentSharedUsersOnRead();

    // Construct where options
    const whereOptions: FindOptionsWhere<User> = {};
    if (query.slug) whereOptions.slug = query.slug;
    if (query.branch) whereOptions.branch = { slug: query.branch };
    if (!_.isEmpty(query.role))
      whereOptions.role = {
        name: In(query.role),
      };

    // QD22.a (buoc 2.5) - loc khach theo ma the. Truoc day JOIN bang the cuc
    // bo; nay tra `/internal/membership-cards/lookup` theo `{ code }` roi loc
    // bang `sharedUserId`. Quet RFID o quay va tab quan ly khach dua vao day.
    //
    // Khong thay the => tra trang rong ngay, khong truy van tiep: `whereOptions`
    // khong co dieu kien nao ve the nua, nen de di tiep la tra ca bang.
    //
    // The co the duoc phat o service kia (dung chung - QD22) nen chu the chua
    // chac co hang cuc bo; cap qua UserProvisioningService truoc khi loc.
    if (query.membershipCard) {
      const card =
        await this.sharedUserServiceClient.lookupMembershipCardByCode(
          query.membershipCard,
        );
      if (!card?.userId) return this.emptyUserPage(query);
      await this.provisionLocalUserForSharedId(card.userId);
      whereOptions.sharedUserId = card.userId;
    }

    if (query.startDate && query.endDate) {
      whereOptions.createdAt = Between(
        new Date(query.startDate),
        new Date(query.endDate),
      );
    } else if (query.startDate) {
      whereOptions.createdAt = MoreThanOrEqual(new Date(query.startDate));
    } else if (query.endDate) {
      whereOptions.createdAt = LessThanOrEqual(new Date(query.endDate));
    }

    // Buoc 8.2 - SDT (chuoi con) va khoang sinh nhat (DD/MM, bo nam) loc truoc o
    // shared-user (`searchSharedUserIdsForFilter`) thay cho `Like` / `dobDM` tren
    // cot cuc bo. Khong ai khop => `In([])` = 0 dong (TypeORM sinh `0=1`).
    // Loc theo the (o tren) da chot mot nguoi => giao voi mang nay.
    const identityIds = await this.searchSharedUserIdsForFilter({
      phonenumber: query.phonenumber,
      dob: {
        type: DobFilterType.DAY_MONTH,
        from: query.birthdayFromDate,
        to: query.birthdayToDate,
      },
    });
    if (identityIds !== null) {
      const cardOwner = whereOptions.sharedUserId as string | undefined;
      whereOptions.sharedUserId = In(
        cardOwner ? identityIds.filter((id) => id === cardOwner) : identityIds,
      );
    }

    // Construct find many options
    const findManyOptions: FindManyOptions<User> = {
      relations: {
        branch: true,
        role: true,
      },
      where: whereOptions,
      order: { createdAt: 'DESC' },
      skip: (query.page - 1) * query.size,
      take: query.size,
    };
    if (query.hasPaging) {
      findManyOptions.skip = (query.page - 1) * query.size;
      findManyOptions.take = query.size;
    }

    // Exec query
    let [users, total] =
      await this.userRepository.findAndCount(findManyOptions);

    // QD19 lop 1b - rong ma nhan vien da go DU mot SDT: tra dung nguoi do ben
    // shared-user, cap hang cuc bo roi truy van lai. Chi ton chi phi khi
    // KHONG thay; co ket qua thi khong goi gi them.
    if (total === 0 && (await this.provisionByExactPhonenumberOnMiss(query))) {
      [users, total] = await this.userRepository.findAndCount(findManyOptions);
    }

    // Calculate total pages
    const page = query.hasPaging ? query.page : 1;
    const pageSize = query.hasPaging ? query.size : total;
    const totalPages = Math.ceil(total / pageSize);

    // Determine hasNext and hasPrevious
    const hasNext = page < totalPages;
    const hasPrevious = page > 1;

    const items = this.mapper.mapArray(users, User, UserResponseDto);
    // Ghep identity moi nhat tu shared-user vao ca trang danh sach - 1 lan
    // goi batch, khong goi lookup rieng theo tung dong (architect-http.md
    // muc 1.1 quy tac 4).
    //
    // Fail-closed, giong getUserBySlug: goi hong thi tra 503 thay vi tra 200
    // kem cot `isActive` cuc bo (luon `true`, ke ca voi tai khoan vua bi
    // khoa) - dung lo hong tester ghi ngay 03/09/2026
    // (tests/tester-issues/1.3.9.xlsx dong 38).
    try {
      const sharedUserIds = users
        .map((user) => user.sharedUserId)
        .filter(Boolean);
      const identities =
        await this.sharedUserServiceClient.lookupByIds(sharedUserIds);
      const identityById = new Map(
        identities.map((identity) => [identity.id, identity]),
      );
      // QD22 (buoc 2.5) - field `membershipCard` cua ca trang: MOT luot batch
      // nua, khong goi lookup rieng tung dong (muc 1.1 quy tac 4). Nguoi khong
      // co the thi vang mat trong ket qua => `null` sau khi map.
      const cards =
        await this.sharedUserServiceClient.lookupMembershipCardsByUserIds(
          sharedUserIds,
        );
      const cardByUserId = new Map(cards.map((card) => [card.userId, card]));
      // Goi merge cho MOI dong, ke ca dong khong tra cuu duoc identity:
      // chinh nhanh `if (identity)` cu la cho tai khoan bi khoa lot qua voi
      // `isActive` cuc bo con nguyen.
      items.forEach((dto, index) => {
        const identity = identityById.get(users[index].sharedUserId);
        this.mergeSharedUserIdentity(dto, identity ?? null);
        dto.membershipCard = toMembershipCardResponse(
          cardByUserId.get(users[index].sharedUserId),
        );
        // Chi route nay co field `userRequirements` tu truoc 2.5 (no nap quan
        // he; cac route user khac thi khong) - gan dung o day de khong doi
        // shape cua route khac, xem ghi chu o `mergeSharedUserIdentity`.
        dto.userRequirements = toUserRequirementResponses(
          identity?.userRequirements,
        );
      });
    } catch (error) {
      this.logger.error(
        `Failed to batch-enrich user list identity from shared-user: ${error?.message}`,
        error?.stack,
        `${UserService.name}.${this.getAllUsers.name}`,
      );
      throw new SharedUserUnavailableException();
    }

    return {
      hasNext: hasNext,
      hasPrevios: hasPrevious,
      items,
      total,
      page,
      pageSize,
      totalPages,
    } as AppPaginatedResponseDto<UserResponseDto>;
  }

  /**
   * Export users to an Excel file containing name, phone number and date of birth.
   * Supports filtering by branch, phone number and a date of birth range that
   * matches by day, month or day+month (the year is ignored).
   * Note: `dob` is stored as a `DD/MM/YYYY` string, so the range is filtered in
   * memory after fetching.
   */
  async exportUsersToExcel(query: ExportUserQueryRequestDto): Promise<Buffer> {
    const context = `${UserService.name}.${this.exportUsersToExcel.name}`;

    const whereOptions: FindOptionsWhere<User> = {};
    if (!_.isEmpty(query.role))
      whereOptions.role = {
        name: In(query.role),
      };

    // Buoc 8.2 - SDT va khoang ngay sinh (theo ngay / thang / ngay+thang, bo
    // nam) loc truoc o shared-user, thay cho `Like` tren cot SDT va loc trong
    // bo nho tren `user.dob` cuc bo (doi ten o 8.9 => file rong im lang).
    const identityIds = await this.searchSharedUserIdsForFilter({
      phonenumber: query.phonenumber,
      dob: {
        type: query.dobFilterType ?? DobFilterType.DAY_MONTH,
        from: query.dobStartDate,
        to: query.dobEndDate,
      },
    });
    if (identityIds !== null) whereOptions.sharedUserId = In(identityIds);

    const users = await this.userRepository.find({
      relations: { branch: true, role: true },
      where: whereOptions,
      order: { createdAt: 'DESC' },
    });

    // Ghep identity moi nhat tu shared-user - danh sach dung de xuat file
    // cho nguoi dung xem/luu lai, khong the de ten/SDT/ngay sinh la ban cuc
    // bo co the cu (architect-http.md muc 1.1 quy tac 4, cung pattern
    // getAllUsers). 1 lan goi batch, khong goi rieng tung dong.
    // Buoc 8.3: FAIL-CLOSED (truoc la fail-open, rot ve cot cuc bo) - cot
    // identity cuc bo doi ten o 8.9, khong con gi de rot ve; shared-user
    // khong tra loi => 503, khong xuat mot file ten/SDT trong.
    const identityById = new Map<
      string,
      Awaited<ReturnType<SharedUserServiceClient['lookupByIds']>>[number]
    >();
    const sharedUserIds = users
      .map((user) => user.sharedUserId)
      .filter(Boolean);
    const identities =
      await this.sharedUserServiceClient.lookupByIds(sharedUserIds);
    identities.forEach((identity) => identityById.set(identity.id, identity));

    // Build workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Users');
    worksheet.columns = [
      { header: 'No.', key: 'index', width: 6 },
      { header: 'Name', key: 'name', width: 30 },
      { header: 'Phone number', key: 'phonenumber', width: 18 },
      { header: 'Date of birth', key: 'dob', width: 16 },
      { header: 'Role', key: 'role', width: 16 },
    ];
    worksheet.getRow(1).font = { bold: true };

    users.forEach((user, index) => {
      const identity = identityById.get(user.sharedUserId);
      const name = [identity?.firstName, identity?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      worksheet.addRow({
        index: index + 1,
        name: name || 'N/A',
        phonenumber: identity?.phonenumber ?? 'N/A',
        dob: identity?.dob ?? 'N/A',
        role: user.role.name || 'N/A',
      });
    });

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    this.logger.log(`Exported ${users.length} users to Excel`, context);
    return Buffer.from(arrayBuffer);
  }

  private buildGroupByExpr(groupBy: string): string {
    const col = 'user.created_at_column';
    switch (groupBy) {
      case 'hour':
        return `DATE_FORMAT(${col}, '%Y-%m-%dT%H:00:00')`;
      case 'week':
        return `DATE_FORMAT(DATE_SUB(${col}, INTERVAL WEEKDAY(${col}) DAY), '%Y-%m-%dT00:00:00')`;
      case 'month':
        return `DATE_FORMAT(${col}, '%Y-%m-01T00:00:00')`;
      case 'year':
        return `DATE_FORMAT(${col}, '%Y-01-01T00:00:00')`;
      default:
        return `DATE_FORMAT(${col}, '%Y-%m-%dT00:00:00')`;
    }
  }

  async getUserStatistics(
    query: GetUserStatisticsQueryRequestDto,
  ): Promise<UserStatisticsResponseDto> {
    const groupBy = query.groupBy ?? 'day';
    const groupByExpr = this.buildGroupByExpr(groupBy);

    const qb = this.userRepository
      .createQueryBuilder('user')
      .innerJoin('user.role', 'role')
      .where('role.name = :roleName', { roleName: RoleEnum.Customer })
      .select(groupByExpr, 'time')
      .addSelect('COUNT(*)', 'count')
      .groupBy(groupByExpr)
      .orderBy(groupByExpr, 'ASC');

    if (query.startDate) {
      qb.andWhere('user.createdAt >= :startDate', {
        startDate: new Date(query.startDate),
      });
    }
    if (query.endDate) {
      qb.andWhere('user.createdAt <= :endDate', {
        endDate: new Date(query.endDate),
      });
    }

    const rawResults = await qb.getRawMany();

    const data: UserStatisticItemDto[] = rawResults.map((r) => ({
      time: String(r.time),
      count: parseInt(r.count, 10),
    }));

    const total = data.reduce((sum, item) => sum + item.count, 0);

    return { data, total };
  }

  async findAllAccountRevenue(
    query: GetAccountRevenueQueryDto,
  ): Promise<AggregateAccountRevenueResponseDto> {
    const context = `${UserService.name}.${this.findAllAccountRevenue.name}`;
    if (!query.branch) {
      this.logger.error(`Branch is not provided`, null, context);
      throw new BadRequestException(`Branch must be provided`);
    }
    const branch = await this.branchUtils.getBranch({
      where: { slug: query.branch },
    });

    const hasStartDate = !!query.startDate;
    const hasEndDate = !!query.endDate;

    if (
      hasStartDate &&
      hasEndDate &&
      new Date(query.startDate).getTime() > new Date(query.endDate).getTime()
    ) {
      this.logger.warn(
        RevenueValidation.START_DATE_ONLY_SMALLER_OR_EQUAL_END_DATE.message,
        context,
      );
      throw new RevenueException(
        RevenueValidation.START_DATE_ONLY_SMALLER_OR_EQUAL_END_DATE,
      );
    }

    // Registered-within-range filter only makes sense with a date range
    const onlyNewCustomers =
      (hasStartDate || hasEndDate) &&
      query.customerType === AccountRevenueCustomerType.NEW_REGISTER;
    // THU TU LA HOP DONG, khong phai gu. `?` la VI TRI chu khong phai ten:
    // hai phan tu dau phai khop hai `?` co dinh dau `accountRevenueFromWhereClause`
    // (`o.branch_column`, roi `u.shared_user_id_column`), moi `params.push`
    // duoi day khop mot `?` CO DIEU KIEN theo dung thu tu chung xuat hien
    // trong cau. Chen sai cho thi cau van chay, van ra so, va **so do sai** -
    // khong co exception nao. Them `?` moi thi them vao day DUNG VI TRI cua no.
    const params: string[] = [branch.id, DEFAULT_CUSTOMER_SHARED_ID];

    // 'YYYY-MM-DDTHH:mm:ss' local time → MySQL datetime literal
    const startParam = query.startDate?.replace('T', ' ');
    const endParam = query.endDate?.replace('T', ' ');
    if (hasStartDate) params.push(startParam);
    if (hasEndDate) params.push(endParam);
    if (onlyNewCustomers) {
      if (hasStartDate) params.push(startParam);
      if (hasEndDate) params.push(endParam);
    }

    if (query.paymentMethod) params.push(query.paymentMethod);

    // QD4 (buoc 7.2) - o tim SDT loc TRUOC o shared-user: khop chuoi con ben
    // do, nhan mang id, roi `u.shared_user_id_column IN (...)` (cung vi tri
    // `?` cuoi cung cua ban `LIKE` cu). Khong nhap SDT thi KHONG goi.
    // Vuot tran 500 => 400 ma 137007 "tim hep lai" (khong cat bot);
    // shared-user khong tra loi => 503 (fail-closed - day la bo loc chinh
    // cua response, roi ve cot cuc bo la sai lech D9).
    // Cau SQL nay KHONG co LIMIT/OFFSET (tra het khach cua chi nhanh roi
    // `reduce` o duoi), nen loc truoc khong lam meo phan trang nao.
    const phonenumberFragment = query.phonenumber?.trim();
    const matchedSharedUserIds = phonenumberFragment
      ? await this.sharedUserServiceClient.searchIdsByPhonenumber(
          phonenumberFragment,
        )
      : [];
    params.push(...matchedSharedUserIds);

    const clauseOptions = {
      hasStartDate,
      hasEndDate,
      onlyNewCustomers,
      hasPaymentMethod: !!query.paymentMethod,
      sharedUserIdCount: matchedSharedUserIds.length,
    };

    // Co nhap SDT ma shared-user khong khop ai => khong co khach nao: bo
    // qua truy van (`IN ()` rong la loi cu phap), di tiep voi mang rong de
    // response giu nguyen shape.
    const noPhonenumberMatch =
      !!phonenumberFragment && matchedSharedUserIds.length === 0;
    const [results, statisticResults]: [
      AccountRevenueQueryResponseDto[],
      AccountRevenueStatisticQueryResponseDto[],
    ] = noPhonenumberMatch
      ? [[], []]
      : await Promise.all([
          this.userRepository.query(
            getAccountRevenueClause(clauseOptions),
            params,
          ),
          this.userRepository.query(
            getAccountRevenueStatisticClause({
              ...clauseOptions,
              groupBy: query.groupBy ?? UserStatisticsGroupBy.DAY,
            }),
            params,
          ),
        ]);

    // Ten khach chi con o shared-user (buoc 8.2: SQL tho khong con
    // `CONCAT(first_name, last_name)` cuc bo - cot do doi ten o 8.9 => 500).
    // MOT luot batch; shared-user khong tra loi => 503 (fail-closed, nhu bo loc
    // SDT phia tren - khong con ten cuc bo de roi ve).
    const identities = await batchLookupSharedUserIdentities(
      results.map((item) => item.customerSharedUserId),
      this.sharedUserServiceClient,
      this.logger,
      context,
    );
    const customerNameById = new Map<string, string>();
    identities.forEach((identity) => {
      const name = [identity.firstName, identity.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      if (name) customerNameById.set(identity.id, name);
    });

    const customers: AccountRevenueCustomerResponseDto[] = results.map(
      (item) => ({
        customerSlug: item.customerSlug,
        customerName: customerNameById.get(item.customerSharedUserId) ?? '',
        customerRegisteredAt: moment(item.customerRegisteredAt).toDate(),
        totalAmount: Number(item.totalAmount),
        totalAmountPoint: Number(item.totalAmountPoint),
        totalAmountBank: Number(item.totalAmountBank),
        totalAmountCash: Number(item.totalAmountCash),
        totalAmountCreditCard: Number(item.totalAmountCreditCard),
      }),
    );

    const summary = customers.reduce(
      (acc, item) => {
        acc.totalAmount += item.totalAmount;
        acc.totalAmountPoint += item.totalAmountPoint;
        acc.totalAmountBank += item.totalAmountBank;
        acc.totalAmountCash += item.totalAmountCash;
        acc.totalAmountCreditCard += item.totalAmountCreditCard;
        return acc;
      },
      {
        totalAmount: 0,
        totalAmountPoint: 0,
        totalAmountBank: 0,
        totalAmountCash: 0,
        totalAmountCreditCard: 0,
        percentPoint: 0,
        percentBank: 0,
        percentCash: 0,
        percentCreditCard: 0,
      } as AccountRevenueSummaryResponseDto,
    );

    if (summary.totalAmount > 0) {
      const toPercent = (amount: number) =>
        Math.round((amount / summary.totalAmount) * 10000) / 100;
      summary.percentPoint = toPercent(summary.totalAmountPoint);
      summary.percentBank = toPercent(summary.totalAmountBank);
      summary.percentCash = toPercent(summary.totalAmountCash);
      summary.percentCreditCard = toPercent(summary.totalAmountCreditCard);
    }

    const data: AccountRevenueStatisticItemDto[] = statisticResults.map(
      (item) => ({
        time: String(item.time),
        count: Number(item.count),
        countPoint: Number(item.countPoint),
        countBank: Number(item.countBank),
        countCash: Number(item.countCash),
        countCreditCard: Number(item.countCreditCard),
        totalAmount: Number(item.totalAmount),
        totalAmountPoint: Number(item.totalAmountPoint),
        totalAmountBank: Number(item.totalAmountBank),
        totalAmountCash: Number(item.totalAmountCash),
        totalAmountCreditCard: Number(item.totalAmountCreditCard),
      }),
    );
    const total = data.reduce((sum, item) => sum + item.count, 0);

    return { summary, customers, data, total };
  }

  // toggleActiveUser da bi xoa - khoa/mo khoa tai khoan gio quy het ve
  // shared-user, xem comment trong user.controller.ts.

  async updateUserLanguage(
    userId: string,
    requestData: UpdateUserLanguageRequestDto,
  ) {
    const context = `${UserService.name}.${this.updateUserLanguage.name}`;
    // CO Y khong load quan he `branch`/`role` o day. Ban goc cua route nay
    // cung khong load, nen 2 field do KHONG xuat hien trong JSON tra ve;
    // them relations vao se lam response moc them 2 key - doi shape ngoai
    // chu dich, dung dieu architect-http.md muc 1.4 cam. Buoc ghep identity
    // ben duoi khong can den chung.
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });
    if (!user) {
      this.logger.warn(`User ${userId} not found`, context);
      throw new UserException(UserValidation.USER_NOT_FOUND);
    }

    // `language` la mot field IDENTITY (architect-http.md muc 1.6), chi ghi o
    // shared-user. Buoc 8.3: bo nua ghi cuc bo (dual-write tu giai doan 1) -
    // cot doi ten o 8.9, va khong con cho nao trong trend doc `user.language`
    // cuc bo (thong bao / sinh nhat doc `language` cua shared-user tu giai
    // doan 4-5). Chi con mot lenh ghi nen khong con nhanh bu tru.
    // Khong co identity => 404 (khong tao identity o day).
    const beforeIdentity = await this.sharedUserServiceClient.lookupById(
      user.sharedUserId,
    );
    if (!beforeIdentity) {
      this.logger.error(
        `No shared-user identity for sharedUserId ${user.sharedUserId}`,
        null,
        context,
      );
      throw new UserException(UserValidation.USER_NOT_FOUND);
    }

    const identity = await this.sharedUserServiceClient.updateIdentity(
      user.sharedUserId,
      { language: requestData.language },
    );

    this.logger.log(`User ${user.slug} language has been updated`, context);

    // Ghep identity moi nhat tu shared-user vao response - cung pattern
    // AuthService.getProfile (architect-http.md muc 1.1 quy tac 4). Truoc
    // day route nay map thang tu entity cuc bo nen tra ve ho ten/SDT/email
    // co the da cu. Danh sach field ghep khop dung AuthProfileResponseDto,
    // khong them khong bot (muc 1.4).
    const dto = this.mapper.map(user, User, AuthProfileResponseDto);
    Object.assign(dto, {
      // Buoc 8.3: chi lay tu shared-user - khong rot ve cot cuc bo (doi ten o
      // 8.9); shared-user khong co gia tri thi de trong (fail-closed, muc 1.7).
      phonenumber: identity.phonenumber,
      firstName: identity.firstName,
      lastName: identity.lastName,
      dob: identity.dob,
      email: identity.email,
      address: identity.address,
      image: identity.image,
      // Buoc 4.7: entity khong con hai co nen khong rot ve `dto` (undefined).
      isVerifiedEmail: identity.isVerifiedEmail ?? false,
      isVerifiedPhonenumber: identity.isVerifiedPhonenumber ?? false,
      language: identity.language,
    });
    return dto;
  }
}
