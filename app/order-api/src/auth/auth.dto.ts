import { ApiProperty } from '@nestjs/swagger';
import { IsDate, IsString, Matches } from 'class-validator';
import { AutoMap } from '@automapper/classes';
import { BranchResponseDto } from 'src/branch/branch.dto';
import { RoleResponseDto } from 'src/role/role.dto';
import { UserRequirementResponseDto } from 'src/user/user.dto';

export class InitiateVerifyEmailRequestDto {
  @ApiProperty()
  @AutoMap()
  @IsString()
  email: string;
}
export class VerifyEmailResponseDto {
  @ApiProperty()
  @AutoMap()
  @IsDate()
  expiresAt: Date;
}
export class VerifyPhoneNumberResponseDto {
  @ApiProperty()
  @AutoMap()
  @IsDate()
  expiresAt: Date;
}
export class ConfirmEmailVerificationCodeRequestDto {
  @ApiProperty()
  @AutoMap()
  @IsString()
  code: string;
}
export class ConfirmPhoneNumberVerificationCodeRequestDto {
  @ApiProperty()
  @AutoMap()
  @IsString()
  code: string;
}

// PATCH /auth/profile, PATCH /auth/upload da bi xoa khoi trend (identity
// gio thuoc ve shared-user, client ghi thang sang do) - UpdateAuthProfileRequestDto
// khong con noi nao dung, da xoa cung dot.

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
