import { Injectable } from '@nestjs/common';
import { InjectMapper } from '@automapper/nestjs';
import { Mapper } from '@automapper/core';
import { UserScopeDto } from 'src/user/user.dto';
import { User } from 'src/user/user.entity';
import { AuthValidation } from './auth.validation';
import { AuthException } from './auth.exception';
import { RoleEnum } from 'src/role/role.enum';
import { Branch } from 'src/branch/branch.entity';
import { BranchResponseDto } from 'src/branch/branch.dto';
import {
  UserRequirementKey,
  UserRequirementLevel,
  UserRequirementStatus,
} from 'src/user/user.constant';

@Injectable()
export class AuthUtils {
  constructor(
    @InjectMapper()
    private readonly mapper: Mapper,
  ) {}

  buildScope(user: User): string {
    const scope: UserScopeDto = {
      role: user.role?.name,
      permissions: [],
      branch: user.branch
        ? this.mapper.map(user.branch, Branch, BranchResponseDto)
        : null,
    };

    const authorityGroupCodes = new Set<string>();
    user.role?.permissions.forEach((permission) => {
      if (!authorityGroupCodes.has(permission.authority.authorityGroup.code)) {
        authorityGroupCodes.add(permission.authority.authorityGroup.code);
      }
    });

    scope.permissions = Array.from(authorityGroupCodes);

    return JSON.stringify(scope);
  }

  parseScope(scope: string): UserScopeDto {
    return JSON.parse(scope);
  }
}

export function checkActiveUser(user: User): void {
  if (!user?.isActive) {
    throw new AuthException(AuthValidation.USER_NOT_ACTIVE);
  }
}

export function checkUserRequirement(user: User): void {
  if (
    user.userRequirements.find(
      (requirement) =>
        requirement.key === UserRequirementKey.NEED_UPDATE_PASSWORD &&
        requirement.status === UserRequirementStatus.PENDING &&
        requirement.level === UserRequirementLevel.BLOCK,
    )
  ) {
    throw new AuthException(AuthValidation.NEED_UPDATE_PASSWORD);
  }
  if (
    user.userRequirements.find(
      (requirement) =>
        requirement.key === UserRequirementKey.NEED_UPDATE_PHONE_NUMBER &&
        requirement.status === UserRequirementStatus.PENDING &&
        requirement.level === UserRequirementLevel.BLOCK,
    )
  ) {
    throw new AuthException(AuthValidation.NEED_UPDATE_PHONE_NUMBER);
  }
}

export function isDefinedCustomer(user: User): boolean {
  if (
    user.role?.name === RoleEnum.Customer &&
    user.phonenumber !== 'default-customer'
  )
    return true;

  return false;
}
