import { Repository, In, IsNull } from 'typeorm';
import { Logger } from '@nestjs/common';
import { User } from './user.entity';
import {
  SharedUserLookupResponse,
  SharedUserServiceClient,
} from 'src/external-services/shared-user-service/shared-user-service.client';

// Bo field dung de ghep vao createdBy (GeneralUserResponseDto) - CHI 3 field
// nay, khong duoc them field khac vao day vi DTO dich chi khai bao dung 3
// field (architect-http.md muc 1.4 - khong tu y doi shape response).
export const GENERAL_IDENTITY_FIELDS = [
  'phonenumber',
  'firstName',
  'lastName',
] as const;

// Bo field day du dung khi dich la UserResponseDto (vd
// UserGroupMemberResponseDto.user) - cung danh sach field dang dung o
// UserService.mergeSharedUserIdentity.
export const FULL_IDENTITY_FIELDS = [
  'phonenumber',
  'firstName',
  'lastName',
  'dob',
  'email',
  'address',
  'image',
  'isVerifiedEmail',
  'isVerifiedPhonenumber',
] as const;

/**
 * Gan de tung field trong `fields` tu `identity` vao `target` neu gia tri
 * tuong ung ben identity khong phai undefined. Dung chung cho ca merge rut
 * gon (createdBy) lan day du (user) - chi khac danh sach field truyen vao.
 */
export const mergeSharedUserIdentityInto = <T extends Record<string, any>>(
  target: T,
  identity: Partial<SharedUserLookupResponse> | null | undefined,
  fields: readonly string[],
): T => {
  if (!identity) return target;
  for (const field of fields) {
    if (identity[field] !== undefined) target[field as keyof T] = identity[field];
  }
  return target;
};

/**
 * Batch tra identity nhieu user cung luc theo sharedUserId, dung khi can
 * ghep identity vao 1 trang danh sach/chi tiet (tranh goi lookup N+1 lan).
 * Fail-open: loi mang chi log warning va tra Map rong, khong lam hong ca
 * request - day la enrichment hien thi, khong phai kiem tra bao mat.
 */
export const batchLookupSharedUserIdentities = async (
  sharedUserIds: Array<string | null | undefined>,
  sharedUserServiceClient: SharedUserServiceClient,
  logger: Logger,
  context: string,
): Promise<Map<string, SharedUserLookupResponse>> => {
  const ids = Array.from(
    new Set(sharedUserIds.filter((id): id is string => Boolean(id))),
  );
  if (!ids.length) return new Map();

  try {
    const identities = await sharedUserServiceClient.lookupByIds(ids);
    return new Map(identities.map((identity) => [identity.id, identity]));
  } catch (error) {
    logger.warn(
      `Failed to batch-lookup shared-user identities, falling back to local cache: ${error?.message}`,
      context,
    );
    return new Map();
  }
};

/**
 * Attach createdBy user to array entity
 * @param entities - Array of entities
 * @param userRepo - User repository
 * @param mapField - Field name to map createdBy user
 * @returns Array of entities with createdBy user
 */
export const attachCreatedByForArrayEntity = async <
  T extends { createdBy?: string | null },
>(
  entities: T[],
  userRepo: Repository<User>,
): Promise<Array<T & { createdBy: User | null }>> => {
  if (!entities || entities.length === 0) return [];

  const ids = Array.from(
    new Set(entities.map((e) => e.createdBy).filter(Boolean)),
  ) as string[];

  if (ids.length === 0) {
    return entities.map((e) => ({ ...e, ['createdBy']: null }));
  }

  // Query user
  const users = await userRepo.find({
    where: { id: In(ids) },
  });

  const userMap = new Map(users.map((u) => [u.id, u]));

  return entities.map((e) => ({
    ...e,
    ['createdBy']: e.createdBy ? (userMap.get(e.createdBy) ?? null) : null,
  }));
};

/**
 * Attach createdBy user to single entity
 * @param entities - Single entity
 * @param userRepo - User repository
 * @param mapField - Field name to map createdBy user
 * @returns Single entity with createdBy user
 */
export const attachCreatedByForSingleEntity = async <
  T extends { createdBy?: string | null },
>(
  entity: T,
  userRepo: Repository<User>,
): Promise<T & { createdBy: User | null }> => {
  if (!entity) return null;

  // Query user
  const user = await userRepo.findOne({
    where: { id: entity.createdBy ?? IsNull() },
  });

  return { ...entity, ['createdBy']: user ?? null };
};
