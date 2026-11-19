import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { AutoMap } from '@automapper/classes';
import { BranchResponseDto } from 'src/branch/branch.dto';
import { RoleResponseDto } from 'src/role/role.dto';
import { UserRequirementResponseDto } from 'src/user/user.dto';

/**
 * Buoc 3.3 (giai doan 3) - tep nay chi con DUNG HAI class:
 * `AuthProfileResponseDto` (route `GET /auth/profile`) va `AuthJwtPayload`
 * (`JwtStrategy` doc payload token).
 *
 * Nam class kia da xoa, ca nam deu la DTO xac minh email / SDT:
 * `InitiateVerifyEmailRequestDto`, `VerifyEmailResponseDto`,
 * `VerifyPhoneNumberResponseDto`, `ConfirmEmailVerificationCodeRequestDto`,
 * `ConfirmPhoneNumberVerificationCodeRequestDto`. Nghiep vu do thuoc ve
 * `shared-user` tu giai doan 1, va sau buoc 3.2 khong con route hay method nao
 * o day doc chung. Do 15/11/2026 TUNG class mot tren `b270d42`: ba class khong
 * tep nao khac nhac toi; hai class con lai chi song nho mot map -
 * `VerifyEmailResponseDto` trong `auth.mapper.ts`,
 * `VerifyPhoneNumberResponseDto` trong `zalo-oa-connector.mapper.ts` - va ca
 * hai map do cung bi xoa trong chinh buoc nay.
 *
 * GIU `isVerifiedEmail` / `isVerifiedPhonenumber` tren DTO phan hoi: hai field
 * nay lay gia tri tu identity cua `shared-user` (xem `auth.service.ts`),
 * khong phai tu cot cuc bo - bo chung la doi shape phan hoi (muc 1.4), va cot
 * cuc bo thi den giai doan 4.7 moi doi ten.
 */
export class AuthProfileResponseDto {
  @AutoMap()
  @ApiProperty()
  readonly slug: string;

  @ApiProperty()
  @AutoMap()
  readonly phonenumber: string;

  @ApiProperty()
  @AutoMap()
  readonly firstName?: string;

  @ApiProperty()
  @AutoMap()
  readonly lastName?: string;

  @AutoMap()
  @ApiProperty()
  @Matches(/^(0[1-9]|[12]\d|3[0-1])\/(0[1-9]|1[0-2])\/(19|20)\d{2}$/, {
    message: 'Invalid day of birth format dd/mm/yyyy',
  })
  readonly dob: string;

  @AutoMap()
  @ApiProperty()
  readonly email?: string;

  @AutoMap()
  @ApiProperty()
  readonly address: string;

  @AutoMap()
  @ApiProperty()
  readonly image: string;

  @AutoMap(() => BranchResponseDto)
  @ApiProperty({ type: () => BranchResponseDto })
  readonly branch: BranchResponseDto;

  @AutoMap(() => RoleResponseDto)
  @ApiProperty()
  role: RoleResponseDto;

  @AutoMap()
  @ApiProperty()
  isVerifiedEmail: boolean;

  @AutoMap()
  @ApiProperty()
  isVerifiedPhonenumber: boolean;

  @AutoMap()
  @ApiProperty()
  readonly language: string;

  @AutoMap(() => UserRequirementResponseDto)
  @ApiProperty({ type: () => UserRequirementResponseDto })
  userRequirements: UserRequirementResponseDto[];
}

export class AuthJwtPayload {
  sub: string;
  jti: string;
  exp?: number;
}
