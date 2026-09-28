import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  ValidationPipe,
} from '@nestjs/common';
import { Response } from 'express';
import { UserService } from './user.service';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AppPaginatedResponseDto, AppResponseDto } from 'src/app/app.dto';
import {
  AggregateAccountRevenueResponseDto,
  CompleteUserRegistrationRequestDto,
  CreateUserRequestDto,
  CurrentUserDto,
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
  UserStatisticsResponseDto,
} from './user.dto';
import { ApiResponseWithType } from 'src/app/app.decorator';
import { HasRoles } from 'src/role/roles.decorator';
import { RoleEnum } from 'src/role/role.enum';
import { CurrentUser } from './user.decorator';
import { AuthProfileResponseDto } from 'src/auth/auth.dto';
import { UserScheduler } from './user.scheduler';

@Controller('user')
@ApiTags('User')
@ApiBearerAuth()
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly userScheduler: UserScheduler,
  ) {}

  @Post('birthday/trigger')
  @HasRoles(RoleEnum.Admin, RoleEnum.SuperAdmin)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manually run the birthday greeting scheduler (for testing)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Birthday greeting scheduler has been triggered successfully',
  })
  async triggerBirthdayScheduler(): Promise<AppResponseDto<void>> {
    await this.userScheduler.BirthdayStrategyScheduler();
    return {
      message: 'Birthday greeting scheduler has been triggered successfully',
      statusCode: HttpStatus.OK,
      timestamp: new Date().toISOString(),
    } as AppResponseDto<void>;
  }

  // ⛔ LO HONG CUA GIAI DOAN 1 - VA 25/09/2026.
  //
  // Route nay TUNG khong co `@HasRoles`. `RolesGuard` cho qua khi thieu
  // decorator, nen bat ky tai khoan dang nhap nao - **ke ca `Customer`** -
  // cung list duoc toan bo nguoi dung kem SDT / ho ten / email. Do tren moi
  // truong song 12/09/2026: token cua mot khach that goi ra **200 + 916
  // khach**. Moi route quan tri khac trong chinh controller nay deu da gac;
  // rieng no thi khong.
  //
  // Sau QD19 lop 1, route nay con **kich hoat sync-on-read**, tuc mot khach
  // ep duoc `trend` goi sang `shared-user`. Throttle 60s toan cum chan muc
  // khuech dai o 1 lenh/phut, nhung phan LO DU LIEU thi nguyen ven - nen phai
  // gac, khong dua vao throttle. Lop 1b (tra dung SDT khi rong) con KHONG
  // throttle - bo guard nay la khach do duoc SDT cua bat ky ai.
  //
  // KHONG gac duoc bang mot dong `@HasRoles(Manager, Admin, SuperAdmin)`: o
  // tim nguoi nhan the qua o man KHACH cung goi vao day. Nen liet ke **moi
  // role tru `Customer`**, va tach nhu cau that cua khach sang
  // `GET /user/lookup-recipient` ngay ben duoi.
  @Get()
  @HasRoles(
    RoleEnum.Staff,
    RoleEnum.Chef,
    RoleEnum.Manager,
    RoleEnum.Admin,
    RoleEnum.SuperAdmin,
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retrieve all user' })
  @ApiResponseWithType({
    status: HttpStatus.OK,
    description: 'All users have been retrieved successfully',
    type: UserResponseDto,
    isArray: true,
  })
  async getAllUsers(
    @Query(new ValidationPipe({ transform: true }))
    query: GetAllUserQueryRequestDto,
  ): Promise<AppResponseDto<AppPaginatedResponseDto<UserResponseDto>>> {
    const result = await this.userService.getAllUsers(query);
    return {
      message: 'All users have been retrieved successfully',
      statusCode: HttpStatus.OK,
      timestamp: new Date().toISOString(),
      result,
    } as AppResponseDto<AppPaginatedResponseDto<UserResponseDto>>;
  }

  /**
   * QD16-bis - duong tra NGUOI NHAN the qua: cua HEP thay cho `GET /user` o
   * man KHACH.
   *
   * Khop SDT **tuyet doi** (khong khop chuoi con - do la rui ro R6), tra **toi
   * da 1 nguoi** va **toi thieu field**. Nghiep vu day du + bon rang buoc:
   * `UserService.lookupRecipient`.
   *
   * ⚠ Phai khai TRUOC `@Get(':slug')` - khong thi Nest bat `lookup-recipient`
   * thanh mot `:slug`.
   */
  @Get('lookup-recipient')
  @HasRoles(
    RoleEnum.Customer,
    RoleEnum.Staff,
    RoleEnum.Chef,
    RoleEnum.Manager,
    RoleEnum.Admin,
    RoleEnum.SuperAdmin,
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Look up one gift-card recipient by exact phone number',
  })
  @ApiResponseWithType({
    status: HttpStatus.OK,
    description: 'The recipient has been retrieved successfully',
    type: RecipientResponseDto,
    isArray: true,
  })
  async lookupRecipient(
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: LookupRecipientQueryRequestDto,
  ): Promise<AppResponseDto<RecipientResponseDto[]>> {
    const result = await this.userService.lookupRecipient(query);
    return {
      message: 'The recipient has been retrieved successfully',
      statusCode: HttpStatus.OK,
      timestamp: new Date().toISOString(),
      result,
    } as AppResponseDto<RecipientResponseDto[]>;
  }

  // QD16 - hai route quan tri nguoi dung chuyen tu `shared-user` ve day. Day
  // la thu dong R1: admin vua duoc cap quyen qua `POST /user/role` truoc day
  // bi 403 oan, vi `shared-user` gac bang mot ban `role_tbl` cua chinh no ma
  // khong ai cap nhat.
  //
  // Chieu goi cu:  Client -> shared-user (gac bang @HasRoles cua shared-user)
  // Chieu goi moi: Client -> trend (gac bang role cua trend) -> /internal/*
  //
  // Giu NGUYEN path va shape request/response cua hai route cu, de UI chi phai
  // doi client chu khong phai doi type hay man hinh.
  @Post(':slug/reset-password')
  @HasRoles(RoleEnum.Manager, RoleEnum.Admin, RoleEnum.SuperAdmin)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reset password of a user (delegates to shared-user)',
  })
  @ApiResponseWithType({
    status: HttpStatus.OK,
    description: 'User password has been reset successfully',
    type: UserResponseDto,
  })
  async resetPassword(
    @Param('slug') slug: string,
  ): Promise<AppResponseDto<UserResponseDto>> {
    await this.userService.resetPasswordForUser(slug);
    return {
      message: 'User password has been reset successfully',
      statusCode: HttpStatus.OK,
      timestamp: new Date().toISOString(),
    } as AppResponseDto<UserResponseDto>;
  }

  // Khong nhan body - giu dung shape cua route cu ben `shared-user`. Viec dao
  // trang thai lam o service (doc trang thai that tu `shared-user` roi gui gia
  // tri DICH sang), khong phai o route noi bo.
  @Patch(':slug/toggle-active')
  @HasRoles(RoleEnum.Manager, RoleEnum.Admin, RoleEnum.SuperAdmin)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Toggle user active status (delegates to shared-user)',
  })
  @ApiResponseWithType({
    status: HttpStatus.OK,
    description: 'User active status has been toggled successfully',
    type: UserResponseDto,
  })
  async toggleActiveUser(
    @Param('slug') slug: string,
  ): Promise<AppResponseDto<UserResponseDto>> {
    const result = await this.userService.toggleActiveUser(slug);
    return {
      message: 'User active status has been toggled successfully',
      statusCode: HttpStatus.OK,
      timestamp: new Date().toISOString(),
      result,
    } as AppResponseDto<UserResponseDto>;
  }

  @Post()
  @HasRoles(
    RoleEnum.Staff,
    RoleEnum.Manager,
    RoleEnum.Admin,
    RoleEnum.SuperAdmin,
  )
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create user: trend sets role/branch, then saves identity on shared-user',
  })
  @ApiResponseWithType({
    status: HttpStatus.CREATED,
    description: 'User has been created successfully',
    type: UserResponseDto,
  })
  async createUser(
    @Body(new ValidationPipe({ transform: true }))
    requestData: CreateUserRequestDto,
  ): Promise<AppResponseDto<UserResponseDto>> {
    const result = await this.userService.createUser(requestData);
    return {
      message: 'User has been created successfully',
      statusCode: HttpStatus.CREATED,
      timestamp: new Date().toISOString(),
      result,
    } as AppResponseDto<UserResponseDto>;
  }

  @Post('role')
  @HasRoles(RoleEnum.Manager, RoleEnum.Admin, RoleEnum.SuperAdmin)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Assign a trend role to a shared-user account (looked up by phonenumber)',
  })
  @ApiResponseWithType({
    status: HttpStatus.OK,
    description: 'User role have been updated successfully',
    type: UserResponseDto,
  })
  async updateUserRole(
    @Body(new ValidationPipe({ transform: true }))
    requestData: UpdateUserRoleRequestDto,
  ) {
    const result = await this.userService.updateUserRole(requestData);
    return {
      message: 'User role has been updated successfully',
      statusCode: HttpStatus.OK,
      timestamp: new Date().toISOString(),
      result,
    } as AppResponseDto<UserResponseDto>;
  }

  @Patch(':slug')
  @HasRoles(RoleEnum.Manager, RoleEnum.Admin, RoleEnum.SuperAdmin)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update user' })
  @ApiResponseWithType({
    status: HttpStatus.OK,
    description: 'User info have been updated successfully',
    type: UserResponseDto,
  })
  async updateUser(
    @Param('slug') slug: string,
    @Body(new ValidationPipe({ transform: true }))
    requestData: UpdateUserRequestDto,
  ) {
    const result = await this.userService.updateUser(slug, requestData);
    return {
      message: 'User has been updated successfully',
      statusCode: HttpStatus.OK,
      timestamp: new Date().toISOString(),
      result,
    } as AppResponseDto<UserResponseDto>;
  }

  @Patch(':slug/complete-registration')
  @HasRoles(
    RoleEnum.Staff,
    RoleEnum.Manager,
    RoleEnum.Admin,
    RoleEnum.SuperAdmin,
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete user registration' })
  @ApiResponseWithType({
    status: HttpStatus.OK,
    description: 'User registration has been completed successfully',
    type: UserResponseDto,
  })
  async completeUserRegistration(
    @Param('slug') slug: string,
    @Body(new ValidationPipe({ transform: true }))
    requestData: CompleteUserRegistrationRequestDto,
  ) {
    await this.userService.completeUserRegistration(slug, requestData);
    return {
      message: 'User registration has been completed successfully',
      statusCode: HttpStatus.NO_CONTENT,
      timestamp: new Date().toISOString(),
    } as AppResponseDto<void>;
  }

  @Get('statistics')
  @HasRoles(RoleEnum.Manager, RoleEnum.Admin, RoleEnum.SuperAdmin)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Get customer registration statistics grouped by hour/day/week/month/year',
  })
  @ApiResponseWithType({
    status: HttpStatus.OK,
    description: 'Customer statistics have been retrieved successfully',
    type: UserStatisticsResponseDto,
  })
  async getUserStatistics(
    @Query(new ValidationPipe({ transform: true }))
    query: GetUserStatisticsQueryRequestDto,
  ): Promise<AppResponseDto<UserStatisticsResponseDto>> {
    const result = await this.userService.getUserStatistics(query);
    return {
      message: 'Customer statistics have been retrieved successfully',
      statusCode: HttpStatus.OK,
      timestamp: new Date().toISOString(),
      result,
    } as AppResponseDto<UserStatisticsResponseDto>;
  }

  @Get('revenue/account')
  @HasRoles(RoleEnum.Manager, RoleEnum.Admin, RoleEnum.SuperAdmin)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get revenue from orders owned by customers with accounts',
  })
  @ApiResponseWithType({
    type: AggregateAccountRevenueResponseDto,
    status: HttpStatus.OK,
    description: 'The account revenues retrieved successfully',
  })
  async findAllAccountRevenue(
    @Query(new ValidationPipe({ transform: true }))
    query: GetAccountRevenueQueryDto,
  ) {
    const result = await this.userService.findAllAccountRevenue(query);
    return {
      message: 'Account revenues have been retrieved successfully',
      statusCode: HttpStatus.OK,
      timestamp: new Date().toISOString(),
      result,
    } as AppResponseDto<AggregateAccountRevenueResponseDto>;
  }

  @Get('export')
  @HasRoles(RoleEnum.Manager, RoleEnum.Admin, RoleEnum.SuperAdmin)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Export user information (name, phone number, date of birth) to Excel',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Users have been exported to Excel successfully',
    content: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  async exportUsersToExcel(
    @Query(new ValidationPipe({ transform: true }))
    query: ExportUserQueryRequestDto,
    @Res() res: Response,
  ) {
    const buffer = await this.userService.exportUsersToExcel(query);
    const filename = `users-${new Date().toISOString().slice(0, 10)}.xlsx`;

    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });

    res.send(buffer);
  }

  @Get(':slug')
  @HasRoles(RoleEnum.SuperAdmin, RoleEnum.Admin, RoleEnum.Manager)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retrieve user by slug' })
  @ApiResponseWithType({
    status: HttpStatus.OK,
    description: 'User has been retrieved successfully',
    type: UserResponseDto,
  })
  async getUserBySlug(
    @Param('slug') slug: string,
  ): Promise<AppResponseDto<UserResponseDto>> {
    const result = await this.userService.getUserBySlug(slug);
    return {
      message: 'User has been retrieved successfully',
      statusCode: HttpStatus.OK,
      timestamp: new Date().toISOString(),
      result,
    } as AppResponseDto<UserResponseDto>;
  }

  // toggle-active da bi xoa khoi trend - khoa/mo khoa tai khoan gio quy het
  // ve shared-user (client goi thang PATCH /user/:slug/toggle-active ben
  // do), vi trend khong con giu ban isActive cua rieng no nua (xem
  // architect-http.md muc 1.1, issuses/sync-user-data-with-role.md).

  @Patch(':slug/language')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update user language' })
  @ApiResponseWithType({
    status: HttpStatus.OK,
    description: 'User language has been updated successfully',
    type: AuthProfileResponseDto,
  })
  async updateUserLanguage(
    @CurrentUser(new ValidationPipe({ validateCustomDecorators: true }))
    currentUserDto: CurrentUserDto,
    @Body(new ValidationPipe({ transform: true }))
    requestData: UpdateUserLanguageRequestDto,
  ): Promise<AppResponseDto<AuthProfileResponseDto>> {
    const result = await this.userService.updateUserLanguage(
      currentUserDto.userId,
      requestData,
    );
    return {
      message: 'User language has been updated successfully',
      statusCode: HttpStatus.OK,
      timestamp: new Date().toISOString(),
      result,
    } as AppResponseDto<AuthProfileResponseDto>;
  }
}
