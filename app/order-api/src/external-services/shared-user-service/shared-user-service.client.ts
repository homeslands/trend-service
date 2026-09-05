import { HttpService } from '@nestjs/axios';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { signInternalRequest } from 'src/common/utils/internal-signature.util';

export interface PingResponse {
  from: string;
  message: string;
  receivedAt: string;
}

export interface SharedUserLookupResponse {
  id: string;
  phonenumber: string;
  slug: string;
  // Khoa/mo khoa tai khoan gio quy het ve shared-user (architect-http.md
  // muc 1.1) - trend khong con giu ban isActive rieng, phai hoi qua day.
  isActive: boolean;
  // Field identity bo sung - dung de ghep vao response cua cac endpoint
  // "can du lieu ca 2 ben" (architect-http.md muc 1.1 quy tac 4), vd
  // GET/POST /user*. Khong co role/branch - shared-user khong tra field do.
  firstName?: string;
  lastName?: string;
  dob?: string;
  email?: string;
  address?: string;
  image?: string;
  isVerifiedEmail?: boolean;
  isVerifiedPhonenumber?: boolean;
  language?: string;
  // Ngay dang ky that ben shared-user - nguon duy nhat de ghi vao
  // user.createdAt khi tu tao row lazy cuc bo (KHONG dung gio tao row/gio
  // job chay), xem issuses/sync-user-data-with-role.md muc 6.3.
  createdAt: string;
}

// Chi gui thong tin identity (khong gui branch) - branch la du lieu cua
// trend, shared_user_db co the da lech branch so voi trend_db tu luc tach.
// `role` van phai gui vi schema User cua shared-user hien con rang buoc NOT
// NULL len quan he role (chua tach hoan toan, xem "no ky thuat" trong
// progress/shared-user.md giai doan 5) - chi la workaround cho constraint
// hien tai, KHONG dung ban role nay lam nguon that; role that nam o trend,
// duoc luu lai ngay sau khi goi xong (xem UserService.createUser ben trend).
export interface CreateSharedUserRequest {
  phonenumber: string;
  password: string;
  firstName?: string;
  lastName?: string;
  dob?: string;
  isVerifiedPhonenumber?: boolean;
  role: string;
}

// Field identity co the sua qua UpdateIdentityRequest - KHONG co role/branch,
// 2 field do khong con thuoc ve shared-user (xem CreateSharedUserRequest).
export interface UpdateSharedUserIdentityRequest {
  phonenumber?: string;
  firstName?: string;
  lastName?: string;
  dob?: string;
  email?: string;
  address?: string;
  image?: string;
  language?: string;
}

// Client wrapper goi HTTP noi bo sang shared-user (/internal/*). Cac module
// khac khong tu dung HttpService truc tiep - luon qua wrapper nay.
@Injectable()
export class SharedUserServiceClient {
  /**
   * Dung cho cac ham DOC (lookupById, lookupByPhonenumber, lookupByIds,
   * listRecent): phan biet ro hai thu ma truoc day bi tron lam mot o vai
   * noi goi.
   *
   * - **404** = shared-user tra loi binh thuong, va cau tra loi la "khong co
   *   user nay". Ben goi tu quyet dinh (chan, hay bo qua buoc ghep).
   * - **Moi thu khac** (mat mang, timeout, 5xx, 403 sai chu ky) = shared-user
   *   KHONG tra loi duoc. Day khong phai "khong tim thay", va tuyet doi khong
   *   duoc de ben goi hieu nham thanh vay.
   *
   * Vi sao chuyen thanh `ServiceUnavailableException` ngay tai day thay vi de
   * tung noi goi tu bat: loi axios KHONG phai `HttpException`, ma
   * `HttpExceptionFilter` lai `@Catch(HttpException)` - nen neu de nguyen, no
   * roi xuong bo xu ly mac dinh cua Nest va ra **500 "Internal server error"**.
   * `JwtStrategy` da tu chuyen thanh 503 tu truoc, con `updateUserRole`,
   * `UserActiveChecker` va `updateUserLanguage` thi chua - cung mot nguyen
   * nhan lai ra hai ma khac nhau tuy endpoint. Gom vao day de moi ham doc
   * hanh xu giong nhau, dung sai lech **D9** da ghi giay to (503 khi
   * shared-user khong tra loi).
   *
   * KHONG ap dung cho cac ham GHI (`createUser`, `updateIdentity`,
   * `revertCreatedUser`): ben goi con doc `error.response.status` de phan biet
   * 400/409 (trung SDT) - boc lai se lam hong nhanh do.
   */
  private toReadError(error: unknown): never {
    const status = (error as { response?: { status?: number } })?.response
      ?.status;
    if (status === 404) throw error;
    throw new ServiceUnavailableException();
  }

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  ping(message: string): Promise<PingResponse> {
    return this.post<PingResponse>('internal/test/ping', {
      from: 'trend',
      message,
    });
  }

  // Tao identity moi ben shared-user (dung khi trend tao user - vd admin
  // tao nhan vien/khach hang). Nem loi nguyen si tu shared-user (vd trung
  // SDT) de tang goi (UserService.createUser) tu quyet dinh cach bao loi.
  createUser(data: CreateSharedUserRequest): Promise<SharedUserLookupResponse> {
    return this.post<SharedUserLookupResponse>('internal/users', data);
  }

  // Bu tru cho createUser (architect-http.md muc 1.2 quy tac 5): goi khi da
  // tao identity thanh cong ben shared-user nhung buoc luu row cuc bo o
  // trend that bai. Ben shared-user tra lai so dien thoai va tat isActive
  // (khong xoa cung hang) - xem UserService.revertCreatedIdentityById.
  revertCreatedUser(id: string): Promise<SharedUserLookupResponse> {
    return this.post<SharedUserLookupResponse>(
      `internal/users/${id}/revert-create`,
      {},
    );
  }

  // Tra ve null neu shared-user khong co user voi phonenumber nay (404),
  // nem loi cho moi truong hop khac (mang, signature sai, 5xx...).
  async lookupByPhonenumber(
    phonenumber: string,
  ): Promise<SharedUserLookupResponse | null> {
    try {
      return await this.post<SharedUserLookupResponse>(
        'internal/users/lookup',
        {
          phonenumber,
        },
      );
    } catch (error) {
      if (error?.response?.status === 404) return null;
      this.toReadError(error);
    }
  }

  // Dung trong JwtStrategy: payload JWT chi co `sub` (id that ben
  // shared-user), khong co phonenumber, nen phai tra theo id khi phat hien
  // user chua tung xuat hien o trend_db (lan dau tu dang ky/dang nhap) - xem
  // issuses/sync-user-data-with-role.md.
  async lookupById(id: string): Promise<SharedUserLookupResponse | null> {
    try {
      return await this.post<SharedUserLookupResponse>(
        'internal/users/lookup',
        {
          id,
        },
      );
    } catch (error) {
      if (error?.response?.status === 404) return null;
      this.toReadError(error);
    }
  }

  // Sua identity (KHONG sua role/branch) cho 1 user da co (theo id that ben
  // shared-user) - dung khi trend can ghi thay doi identity ho user (vd
  // admin sua thong tin nhan vien/khach hang qua PATCH /user/:slug, hoac
  // hoan tat dang ky qua PATCH /user/:slug/complete-registration). Nem loi
  // nguyen si (vd 409 trung SDT) de tang goi tu quyet dinh cach bao loi.
  updateIdentity(
    id: string,
    data: UpdateSharedUserIdentityRequest,
  ): Promise<SharedUserLookupResponse> {
    return this.post<SharedUserLookupResponse>(
      `internal/users/${id}/update-identity`,
      data,
    );
  }

  // Batch cua lookupById - dung khi trend can ghep identity vao ca 1 trang
  // danh sach user (UserService.getAllUsers), tranh goi lookup N+1 lan
  // theo tung dong. Tra mang rong neu ids rong hoac shared-user khong tra
  // duoc dong nao khop.
  async lookupByIds(ids: string[]): Promise<SharedUserLookupResponse[]> {
    if (!ids.length) return [];
    try {
      return await this.post<SharedUserLookupResponse[]>(
        'internal/users/batch-lookup',
        {
          ids,
        },
      );
    } catch (error) {
      this.toReadError(error);
    }
  }

  // Dung cho job batch cuoi ngay (UserScheduler.syncRecentlyRegisteredUsers)
  // - lay danh sach user tao trong khoang [createdFrom, createdTo) de tao
  // row lazy cho khach chua tung dang nhap, xem
  // issuses/sync-user-data-with-role.md muc 6.
  async listRecent(
    createdFrom: Date,
    createdTo: Date,
  ): Promise<SharedUserLookupResponse[]> {
    try {
      return await this.post<SharedUserLookupResponse[]>(
        'internal/users/list-recent',
        {
          createdFrom: createdFrom.toISOString(),
          createdTo: createdTo.toISOString(),
        },
      );
    } catch (error) {
      this.toReadError(error);
    }
  }

  // Moi path, ke ca /internal/*, deu mang tien to api/${version} - phai
  // khop chinh xac voi path that su ma InternalApiGuard cua shared-user
  // nhan duoc (request.originalUrl), neu khong chu ky HMAC se sai.
  private async post<T>(relativePath: string, body: unknown): Promise<T> {
    const baseUrl =
      this.configService.get<string>('SHARED_USER_API_URL') ||
      'http://localhost:8086';
    const version = this.configService.get<string>('VERSION') || 'v1.0.0';
    const path = `/api/${version}/${relativePath}`;
    const secret = this.configService.get<string>('INTERNAL_API_SECRET');
    const timestamp = Date.now().toString();
    const rawBody = JSON.stringify(body);
    const signature = signInternalRequest(
      secret,
      'POST',
      path,
      rawBody,
      timestamp,
    );

    const { data } = await firstValueFrom(
      this.httpService.post<T>(`${baseUrl}${path}`, body, {
        timeout: 5000,
        headers: {
          'X-Signature': signature,
          'X-Timestamp': timestamp,
        },
      }),
    );
    return data;
  }
}
