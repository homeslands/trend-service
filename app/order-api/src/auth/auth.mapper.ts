import { AutomapperProfile, InjectMapper } from '@automapper/nestjs';
import { createMap, extend, Mapper } from '@automapper/core';
import { Injectable } from '@nestjs/common';

import { AuthProfileResponseDto, VerifyEmailResponseDto } from './auth.dto';
import { User } from 'src/user/user.entity';
import { VerifyEmailToken } from './entity/verify-email-token.entity';
import { baseMapper } from 'src/app/base.mapper';

@Injectable()
export class AuthProfile extends AutomapperProfile {
  constructor(@InjectMapper() mapper: Mapper) {
    super(mapper);
  }

  override get profile() {
    return (mapper: Mapper) => {
      createMap(mapper, User, AuthProfileResponseDto);
      createMap(
        mapper,
        VerifyEmailToken,
        VerifyEmailResponseDto,
        extend(baseMapper(mapper)),
      );
    };
  }
}
