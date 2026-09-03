import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindManyOptions,
  FindOptionsWhere,
  In,
  LessThanOrEqual,
  Like,
  MoreThanOrEqual,
  Raw,
  Repository,
} from 'typeorm';
import { User } from './user.entity';
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
import { SharedUserServiceClient } from 'src/external-services/shared-user-service/shared-user-service.client';

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
  ) {}

  private isTodayBirthday(dobDM: string): boolean {
    const today = new Date();
    const todayDM = `${String(today.getDate()).padStart(2, '0')}${String(today.getMonth() + 1).padStart(2, '0')}`;
    return dobDM === todayDM;
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
      isVerifiedEmail?: boolean;
      isVerifiedPhonenumber?: boolean;
      isActive?: boolean;
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
    if (!identity) return dto;
    return Object.assign(dto, {
      phonenumber: identity.phonenumber ?? dto.phonenumber,
      firstName: identity.firstName ?? dto.firstName,
      lastName: identity.lastName ?? dto.lastName,
      dob: identity.dob ?? dto.dob,
      email: identity.email ?? dto.email,
      address: identity.address ?? dto.address,
      isVerifiedEmail: identity.isVerifiedEmail ?? dto.isVerifiedEmail,
      isVerifiedPhonenumber:
        identity.isVerifiedPhonenumber ?? dto.isVerifiedPhonenumber,
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
    try {
      const identity = await this.sharedUserServiceClient.lookupById(
        user.sharedUserId,
      );
      return this.mergeSharedUserIdentity(dto, identity);
    } catch (error) {
      this.logger.error(
        `Failed to enrich user identity from shared-user: ${error?.message}`,
        error?.stack,
        context,
      );
      throw new ServiceUnavailableException();
    }
  }

  // Sua thong tin 1 user (admin-facing). Branch la du lieu cua trend, sua
  // cuc bo binh thuong. Cac field identity (firstName/lastName/dob/email/
  // address) gio thuoc ve shared-user (architect-http.md muc 1.1) - phai ghi
  // sang do TRUOC (fail-closed: shared-user tra loi thi moi luu cuc bo, tranh
  // 2 ban lech nhau vinh vien neu shared-user tu choi vd trung SDT o noi
  // khac), ket qua tra ve ghep tu response cua chinh lan goi do. Van luu lai
  // ban sao cuc bo (khong xoa) vi cac module khac (xuat Excel, campaign sinh
  // nhat...) van doc truc tiep cot cuc bo - ngoai pham vi dot sua nay.
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
    if (hasIdentityChanges && !beforeIdentity) {
      this.logger.error(
        `Shared-user identity not found for sharedUserId ${user.sharedUserId} before update`,
        null,
        context,
      );
      throw new AuthException(AuthValidation.ERROR_UPDATE_USER);
    }

    Object.assign(user, {
      ...requestData,
    });

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

    if ('dob' in requestData) {
      const [day, month] = requestData.dob ? requestData.dob.split('/') : [];
      user.dobDM = day && month ? `${day}${month}` : null;
    }

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
      if (
        requestData.dob &&
        updatedUser.dobDM &&
        this.isTodayBirthday(updatedUser.dobDM)
      )
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
      relations: { userRequirements: true },
    });
    if (!user) throw new UserException(UserValidation.USER_NOT_FOUND);

    const blockedPhonenumberRequirement = user.userRequirements.find(
      (requirement) =>
        requirement.key === UserRequirementKey.NEED_UPDATE_PHONE_NUMBER &&
        requirement.status === UserRequirementStatus.PENDING &&
        requirement.level === UserRequirementLevel.BLOCK &&
        requirement.scope === UserRequirementScope.INITIAL,
    );
    // const blockedPasswordRequirement = user.userRequirements.find(
    //   (requirement) =>
    //     requirement.key === UserRequirementKey.NEED_UPDATE_PASSWORD &&
    //     requirement.status === UserRequirementStatus.PENDING &&
    //     requirement.level === UserRequirementLevel.BLOCK &&
    //     requirement.scope === UserRequirementScope.INITIAL,
    // );

    // Dung de rollback shared-user (architect-http.md muc 1.2 buoc 3) neu
    // buoc luu cuc bo o duoi that bai sau khi da doi SDT thanh cong ben
    // shared-user. Chi set khi thuc su da ghi thanh cong sang shared-user.
    let oldPhonenumberForRollback: string | null = null;

    if (blockedPhonenumberRequirement) {
      if (user.phonenumber === requestData.phonenumber) {
        this.logger.warn(
          AuthValidation.NEED_UPDATE_PHONE_NUMBER.message,
          context,
        );
        throw new AuthException(AuthValidation.NEED_UPDATE_PHONE_NUMBER);
      } else {
        const existedPhonenumber = await this.userRepository.findOne({
          where: {
            phonenumber: requestData.phonenumber,
          },
        });
        if (existedPhonenumber) {
          this.logger.error(
            AuthValidation.PHONE_NUMBER_ALREADY_EXISTS.message,
            null,
            context,
          );
          throw new AuthException(AuthValidation.PHONE_NUMBER_ALREADY_EXISTS);
        }
        // Phonenumber la login key that su - thuoc ve shared-user
        // (architect-http.md muc 1.1). Ghi sang do TRUOC (fail-closed: neu
        // shared-user tu choi - vd 409 vi da bi nguoi khac chiem giua luc
        // check cuc bo va luc goi - thi khong duoc luu ban cuc bo, tranh 2
        // ben lech nhau). Check cuc bo o tren chi la fast-fail, khong phai
        // nguon that.
        const oldPhonenumber = user.phonenumber;
        try {
          await this.sharedUserServiceClient.updateIdentity(user.sharedUserId, {
            phonenumber: requestData.phonenumber,
          });
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
        // Da ghi thanh cong sang shared-user - tu day tro di neu buoc luu
        // cuc bo phia duoi that bai, PHAI rollback ve SDT cu nay
        // (architect-http.md muc 1.2 buoc 3).
        oldPhonenumberForRollback = oldPhonenumber;
        Object.assign(user, {
          phonenumber: requestData.phonenumber,
        });
        blockedPhonenumberRequirement.status = UserRequirementStatus.COMPLETED;
      }
    }

    // if (blockedPasswordRequirement) {
    //   const isMatch = await bcrypt.compare(requestData.password, user.password);
    //   if (isMatch) {
    //     this.logger.warn(AuthValidation.NEED_UPDATE_PASSWORD.message, context);
    //     throw new AuthException(AuthValidation.NEED_UPDATE_PASSWORD);
    //   } else {
    //     const hashedPass = await bcrypt.hash(
    //       requestData.password,
    //       this.saltOfRounds,
    //     );
    //     Object.assign(user, {
    //       password: hashedPass,
    //     });
    //     blockedPasswordRequirement.status = UserRequirementStatus.COMPLETED;
    //   }
    // }

    // if (!blockedPhonenumberRequirement && !blockedPasswordRequirement) {
    //   this.logger.error(
    //     `User ${user.slug} has no blocked requirement`,
    //     context,
    //   );
    //   throw new AuthException(
    //     AuthValidation.USER_NOT_HAVE_ANY_REQUIREMENT_MUST_BE_COMPLETED,
    //   );
    // }
    if (!blockedPhonenumberRequirement) {
      this.logger.error(
        `User ${user.slug} has no blocked phone number requirement`,
        context,
      );
      throw new AuthException(
        AuthValidation.USER_NOT_HAVE_BLOCKED_PHONE_NUMBER_REQUIREMENT,
      );
    }

    if (!user.isActive) {
      user.isActive = true;
    }

    try {
      await this.transactionManagerService.execute<void>(
        async (manager) => {
          await manager.save(user);
          if (blockedPhonenumberRequirement) {
            await manager.save(blockedPhonenumberRequirement);
          }
          // if (blockedPasswordRequirement) {
          //   await manager.save(blockedPasswordRequirement);
          // }
        },
        () => {
          this.logger.log(
            `User ${user.slug} registration has been completed`,
            context,
          );
        },
        (error) => {
          this.logger.warn(
            `Error when completing user registration: ${error.message}`,
            context,
          );
          throw new AuthException(
            AuthValidation.ERROR_COMPLETE_USER_REGISTRATION,
          );
        },
      );
    } catch (error) {
      // Rollback (architect-http.md muc 1.2 buoc 3): shared-user da doi SDT
      // thanh cong nhung buoc luu cuc bo that bai - phai tra SDT ve gia tri
      // cu ben shared-user, khong duoc de 2 ben lech nhau.
      if (oldPhonenumberForRollback) {
        await this.rollbackSharedUserIdentity(
          user.sharedUserId,
          { phonenumber: oldPhonenumberForRollback },
          { phonenumber: requestData.phonenumber },
          context,
        );
      }
      throw error;
    }
  }

  // Tao user moi: trend quyet dinh role/branch (nghiep vu cua no), sau do
  // goi noi bo sang shared-user de luu lai identity (phonenumber, mat khau,
  // ho ten...) - dao nguoc thu tu so voi truoc khi tach (khi do trend tu
  // luu het). Validate role/branch/trung SDT truoc khi goi sang shared-user
  // de khong tao "rac" ben do neu request sai ngay tu dau.
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

    const existingLocalUser = await this.userRepository.findOne({
      where: { phonenumber: requestData.phonenumber },
    });
    if (existingLocalUser) {
      throw new AuthException(AuthValidation.USER_EXISTS);
    }

    let sharedUser: Awaited<ReturnType<SharedUserServiceClient['createUser']>>;
    try {
      sharedUser = await this.sharedUserServiceClient.createUser({
        phonenumber: requestData.phonenumber,
        password: requestData.password,
        firstName: requestData.firstName,
        lastName: requestData.lastName,
        dob: requestData.dob,
        isVerifiedPhonenumber: requestData.isVerifiedPhonenumber,
        // shared-user van con rang buoc NOT NULL len role (chua tach hoan
        // toan) - gui kem de qua duoc constraint, KHONG dung lam nguon that.
        role: requestData.role,
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

    const user = this.userRepository.create({
      phonenumber: sharedUser.phonenumber,
      sharedUserId: sharedUser.id,
      role,
      branch,
    });

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
      throw new UserException(UserValidation.ERROR_CREATE_USER);
    }
  }

  // Gan role cho 1 user cua shared-user (theo phonenumber, khoa dang nhap
  // dung chung giua 2 he thong). Neu trend chua co local row cho nguoi nay
  // (lan dau duoc admin cap quyen), tu tao 1 row toi gian gom sharedUserId +
  // phonenumber + role - khong con flow "tao user + mat khau" rieng, vi
  // identity/mat khau da thuoc ve shared-user.
  async updateUserRole(requestData: UpdateUserRoleRequestDto) {
    const context = `${UserService.name}.${this.updateUserRole.name}`;
    const role = await this.roleRepository.findOne({
      where: {
        slug: requestData.role,
      },
    });
    if (!role) throw new RoleException(RoleValidation.ROLE_NOT_FOUND);

    let user = await this.userRepository.findOne({
      where: { phonenumber: requestData.phonenumber },
      relations: ['role'],
    });

    if (user && user.role?.name === RoleEnum.Customer) {
      this.logger.warn(
        `Can not update customer role to ${role.name} role`,
        context,
      );
      throw new UserException(UserValidation.CANNOT_UPDATE_CUSTOMER_ROLE);
    }

    // Uu tien tra cuu theo `id` neu da biet (architect-http.md muc 1.3) -
    // `id` la khoa chinh that, on dinh hon `phonenumber` (co the doi qua
    // completeUserRegistration). Da co row cuc bo (da tung gan role truoc
    // do) thi dung thang sharedUserId da luu, chi fallback sang
    // lookupByPhonenumber khi chua tung co row cuc bo (lan dau gan role,
    // chua biet id).
    const sharedUser = user
      ? await this.sharedUserServiceClient.lookupById(user.sharedUserId)
      : await this.sharedUserServiceClient.lookupByPhonenumber(
          requestData.phonenumber,
        );
    if (!sharedUser) throw new UserException(UserValidation.USER_NOT_FOUND);

    if (!user) {
      user = this.userRepository.create({
        phonenumber: sharedUser.phonenumber,
        sharedUserId: sharedUser.id,
        // Ngay dang ky that ben shared-user - KHONG de @CreateDateColumn tu
        // sinh theo gio tao row nay (gio admin gan role, khong phai gio
        // dang ky), xem issuses/sync-user-data-with-role.md muc 6.3.
        createdAt: new Date(sharedUser.createdAt),
      });
    }

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
    // Ghep identity - row cuc bo (nhat la khi vua tao lan dau) khong luu du
    // firstName/lastName/..., phai lay tu lan lookup vua goi o tren (khong
    // goi lai lan 2) (architect-http.md muc 1.1 quy tac 4).
    return this.mergeSharedUserIdentity(dto, sharedUser);
  }

  async getAllUsers(
    query: GetAllUserQueryRequestDto,
  ): Promise<AppPaginatedResponseDto<UserResponseDto>> {
    // Construct where options
    const whereOptions: FindOptionsWhere<User> = {};
    if (query.slug) whereOptions.slug = query.slug;
    if (query.branch) whereOptions.branch = { slug: query.branch };
    if (query.phonenumber)
      whereOptions.phonenumber = Like(`%${query.phonenumber}%`);
    if (!_.isEmpty(query.role))
      whereOptions.role = {
        name: In(query.role),
      };

    if (query.membershipCard) {
      whereOptions.membershipCard = {
        code: query.membershipCard,
      };
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

    if (query.birthdayFromDate || query.birthdayToDate) {
      // dobDM is stored as ddmm; reorder to mmdd for correct chronological comparison
      const toMMDD = (ddmm: string) => {
        const [day, month] = ddmm.split('/');
        return `${month}${day}`;
      };
      const fromMMDD = query.birthdayFromDate
        ? toMMDD(query.birthdayFromDate)
        : '0101';
      const toMMDDValue = query.birthdayToDate
        ? toMMDD(query.birthdayToDate)
        : '1231';
      const reorderedExpr = (alias: string) =>
        `CONCAT(SUBSTRING(${alias}, 3, 2), SUBSTRING(${alias}, 1, 2))`;

      whereOptions.dobDM =
        fromMMDD <= toMMDDValue
          ? Raw(
              (alias) =>
                `${alias} IS NOT NULL AND ${reorderedExpr(alias)} BETWEEN :fromMMDD AND :toMMDD`,
              { fromMMDD, toMMDD: toMMDDValue },
            )
          : Raw(
              (alias) =>
                `${alias} IS NOT NULL AND (${reorderedExpr(alias)} >= :fromMMDD OR ${reorderedExpr(alias)} <= :toMMDD)`,
              { fromMMDD, toMMDD: toMMDDValue },
            );
    }

    // Construct find many options
    const findManyOptions: FindManyOptions<User> = {
      relations: {
        branch: true,
        role: true,
        accumulatedPoint: true,
        membershipCard: true,
        balance: true,
        userRequirements: true,
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
    const [users, total] =
      await this.userRepository.findAndCount(findManyOptions);

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
      // Goi merge cho MOI dong, ke ca dong khong tra cuu duoc identity:
      // chinh nhanh `if (identity)` cu la cho tai khoan bi khoa lot qua voi
      // `isActive` cuc bo con nguyen.
      items.forEach((dto, index) => {
        const identity = identityById.get(users[index].sharedUserId);
        this.mergeSharedUserIdentity(dto, identity ?? null);
      });
    } catch (error) {
      this.logger.error(
        `Failed to batch-enrich user list identity from shared-user: ${error?.message}`,
        error?.stack,
        `${UserService.name}.${this.getAllUsers.name}`,
      );
      throw new ServiceUnavailableException();
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
   * Parse a date-of-birth range bound into a comparable numeric key according to
   * the granularity (`day` | `month` | `day_month`). The year is always ignored.
   * - day: `5` / `05` -> 5
   * - month: `6` / `06` -> 6
   * - day_month: `01/06` (DD/MM) -> 601 (month * 100 + day)
   */
  private parseDobBound(value: string, type: DobFilterType): number {
    if (type === DobFilterType.DAY_MONTH) {
      const match = value.match(/^(\d{1,2})\/(\d{1,2})$/);
      if (!match)
        throw new BadRequestException(
          `Invalid date of birth bound "${value}". Expected DD/MM`,
        );
      const day = parseInt(match[1], 10);
      const month = parseInt(match[2], 10);
      if (day < 1 || day > 31 || month < 1 || month > 12)
        throw new BadRequestException(
          `Invalid date of birth bound "${value}". Day must be 1-31, month 1-12`,
        );
      return month * 100 + day;
    }

    if (!/^\d{1,2}$/.test(value))
      throw new BadRequestException(
        `Invalid date of birth bound "${value}". Expected a number`,
      );
    const num = parseInt(value, 10);
    const max = type === DobFilterType.MONTH ? 12 : 31;
    if (num < 1 || num > max)
      throw new BadRequestException(
        `Invalid date of birth bound "${value}". Must be 1-${max}`,
      );
    return num;
  }

  /**
   * Build a comparable numeric key from a user's `dob` (DD/MM/YYYY string),
   * matching the granularity used by {@link parseDobBound}. Returns null when
   * the dob is missing or invalid.
   */
  private dobToKey(dob: string, type: DobFilterType): number | null {
    const parsed = moment(dob, 'DD/MM/YYYY', true);
    if (!parsed.isValid()) return null;
    const day = parsed.date();
    const month = parsed.month() + 1;
    if (type === DobFilterType.DAY) return day;
    if (type === DobFilterType.MONTH) return month;
    return month * 100 + day;
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
    if (query.phonenumber)
      whereOptions.phonenumber = Like(`%${query.phonenumber}%`);

    if (!_.isEmpty(query.role))
      whereOptions.role = {
        name: In(query.role),
      };

    let users = await this.userRepository.find({
      relations: { branch: true, role: true },
      where: whereOptions,
      order: { createdAt: 'DESC' },
    });

    // Filter by date of birth range (dob stored as DD/MM/YYYY; year ignored)
    if (query.dobStartDate || query.dobEndDate) {
      const type = query.dobFilterType ?? DobFilterType.DAY_MONTH;
      const start = query.dobStartDate
        ? this.parseDobBound(query.dobStartDate, type)
        : null;
      const end = query.dobEndDate
        ? this.parseDobBound(query.dobEndDate, type)
        : null;

      users = users.filter((user) => {
        if (!user.dob) return false;
        const key = this.dobToKey(user.dob, type);
        if (key === null) return false;
        if (start !== null && end !== null) {
          // Support wrap-around ranges (e.g. 25/12 -> 05/01)
          return start <= end
            ? key >= start && key <= end
            : key >= start || key <= end;
        }
        if (start !== null) return key >= start;
        if (end !== null) return key <= end;
        return true;
      });
    }

    // Ghep identity moi nhat tu shared-user - danh sach dung de xuat file
    // cho nguoi dung xem/luu lai, khong the de ten/SDT/ngay sinh la ban cuc
    // bo co the cu (architect-http.md muc 1.1 quy tac 4, cung pattern
    // getAllUsers). 1 lan goi batch, khong goi rieng tung dong. Fail-open:
    // loi mang chi log warning, xuat file bang du lieu cuc bo thay vi lam
    // hong ca request.
    const identityById = new Map<
      string,
      Awaited<ReturnType<SharedUserServiceClient['lookupByIds']>>[number]
    >();
    try {
      const sharedUserIds = users
        .map((user) => user.sharedUserId)
        .filter(Boolean);
      const identities =
        await this.sharedUserServiceClient.lookupByIds(sharedUserIds);
      identities.forEach((identity) => identityById.set(identity.id, identity));
    } catch (error) {
      this.logger.warn(
        `Failed to batch-enrich export identity from shared-user, falling back to local cache: ${error?.message}`,
        context,
      );
    }

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
      const firstName = identity?.firstName ?? user.firstName;
      const lastName = identity?.lastName ?? user.lastName;
      const name = [firstName, lastName].filter(Boolean).join(' ').trim();
      worksheet.addRow({
        index: index + 1,
        name: name || 'N/A',
        phonenumber: identity?.phonenumber ?? user.phonenumber ?? 'N/A',
        dob: identity?.dob ?? user.dob ?? 'N/A',
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
    const params: string[] = [branch.id];

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

    if (query.phonenumber) params.push(`%${query.phonenumber}%`);

    const clauseOptions = {
      hasStartDate,
      hasEndDate,
      onlyNewCustomers,
      hasPaymentMethod: !!query.paymentMethod,
      hasPhonenumber: !!query.phonenumber,
    };

    const [results, statisticResults]: [
      AccountRevenueQueryResponseDto[],
      AccountRevenueStatisticQueryResponseDto[],
    ] = await Promise.all([
      this.userRepository.query(getAccountRevenueClause(clauseOptions), params),
      this.userRepository.query(
        getAccountRevenueStatisticClause({
          ...clauseOptions,
          groupBy: query.groupBy ?? UserStatisticsGroupBy.DAY,
        }),
        params,
      ),
    ]);

    // Ghep ten khach hang moi nhat tu shared-user - customerName tu raw SQL
    // la ban cuc bo co the cu (architect-http.md muc 1.1 quy tac 4, cung
    // pattern getAllUsers/exportUsersToExcel). 1 lan goi batch. Fail-open:
    // loi mang chi log warning, dung ban cuc bo thay vi lam hong ca request.
    const customerNameById = new Map<string, string>();
    try {
      const sharedUserIds = results
        .map((item) => item.customerSharedUserId)
        .filter(Boolean);
      const identities =
        await this.sharedUserServiceClient.lookupByIds(sharedUserIds);
      identities.forEach((identity) => {
        const name = [identity.firstName, identity.lastName]
          .filter(Boolean)
          .join(' ')
          .trim();
        if (name) customerNameById.set(identity.id, name);
      });
    } catch (error) {
      this.logger.warn(
        `Failed to batch-enrich account revenue customer name from shared-user, falling back to local cache: ${error?.message}`,
        context,
      );
    }

    const customers: AccountRevenueCustomerResponseDto[] = results.map(
      (item) => ({
        customerSlug: item.customerSlug,
        customerName:
          customerNameById.get(item.customerSharedUserId) || item.customerName,
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
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });
    if (!user) {
      this.logger.warn(`User ${userId} not found`, context);
      throw new UserException(UserValidation.USER_NOT_FOUND);
    }
    user.language = requestData.language;
    await this.userRepository.save(user);
    this.logger.log(`User ${user.slug} language has been updated`, context);
    return this.mapper.map(user, User, AuthProfileResponseDto);
  }
}
