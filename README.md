# 축의금 관리

결혼식별 방을 만들고 4자리 PIN으로 참여자를 제한하는 축의금 관리 웹앱입니다. 화면은 GitHub Pages에서, 공용 데이터와 접근 제어는 Supabase에서 동작합니다.

## 배포 설정

1. [Supabase](https://supabase.com/)에서 새 프로젝트를 만듭니다.
2. Supabase의 **SQL Editor**에서 [`supabase/schema.sql`](supabase/schema.sql) 전체를 실행합니다.
3. Supabase의 **Project Settings → API**에서 Project URL과 `anon` public key를 확인합니다.
4. [`config.js`](config.js)에 두 값을 입력합니다.

```js
window.CHUKUIGEUM_CONFIG = {
  supabaseUrl: 'https://YOUR_PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR_ANON_KEY'
};
```

5. 변경 내용을 `main` 브랜치에 반영하면 기존 GitHub Pages 주소에 배포됩니다.

`anon` key는 브라우저용 공개 키입니다. `service_role` key는 절대 `config.js`나 Git 저장소에 넣지 마세요.

## 접근 방식

- 첫 화면에는 개설된 방 제목이 표시되며, 사용자는 방을 선택한 뒤 4자리 PIN으로 입장합니다.
- 내부 6자리 코드는 공유 링크와 데이터 식별에만 사용되고 화면에서는 요구하지 않습니다.
- PIN 원문은 저장하지 않고 bcrypt 해시만 데이터베이스에 보관합니다.
- PIN 확인 후 발급된 임의 접근 토큰도 해시로 저장되며 30일 후 만료됩니다.
- 각 데이터 작업은 접근 토큰이 속한 방 안에서만 수행됩니다.
- 같은 기기에서 PIN을 5회 틀리면 10분 동안 재시도할 수 없습니다.
- 데이터 테이블에는 RLS가 적용되어 공개 API 키로 직접 조회할 수 없습니다.

4자리 PIN은 공유 편의를 위한 간단한 접근 장치라서 강한 계정 인증을 대신하지는 않습니다. 더 높은 보안이 필요하면 사용자 계정과 이메일 초대 방식을 추가하는 편이 적합합니다.

## 로컬 실행

```bash
python3 -m http.server 8765
```

브라우저에서 `http://127.0.0.1:8765`를 엽니다. 로컬과 배포 페이지가 같은 Supabase 설정을 사용하면 같은 방 데이터를 공유합니다.
