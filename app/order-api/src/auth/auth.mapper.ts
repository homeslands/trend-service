import { AutomapperProfile, InjectMapper } from '@automapper/nestjs';
import { createMap, Mapper } from '@automapper/core';
import { Injectable } from '@nestjs/common';

import { AuthProfileResponseDto } from './auth.dto';
import { User } from 'src/user/user.entity';

/**
 * Buoc 3.3 (giai doan 3) - profile nay con DUNG MOT map:
 * `User -> AuthProfileResponseDto`, phuc vu `GET /auth/profile`.
 *
 * Map kia (`VerifyEmailToken -> VerifyEmailResponseDto`) da xoa cung entity
 * token va DTO xac minh email cua buoc nay. Map anh em cua no
 * (`VerifyPhoneNumberToken -> VerifyPhoneNumberResponseDto`) nam o
 * `zalo-oa-connector.mapper.ts` va cung da xoa. Hai entity token con lai
 * (`ForgotPasswordToken`, `RegisterOtpToken`) khong co map nao o `trend`.
 * Chi map da xoa dung `extend(baseMapper(mapper))`, nen `extend` va
 * `baseMapper` roi khoi danh sach import.
 *
 * Luu y khi doc lai: map cua entity token KHONG can
 * `TypeOrmModule.forFeature` (buoc 3.2 da go chung khoi do) - mapper chi can
 * CLASS. Vi vay o 3.2 tep nay van bien dich binh thuong du forFeature da sach;
 * den 3.3 moi den luot no.
 */
@Injectable()
export class AuthProfile extends AutomapperProfile {
  constructor(@InjectMapper() mapper: Mapper) {
    super(mapper);
  }

  override get profile() {
    return (mapper: Mapper) => {
      createMap(mapper, User, AuthProfileResponseDto);
    };
  }
}
