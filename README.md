# 도서모음

읽은 책을 정리하는 개인용 PWA. 데이터는 **기기(localStorage)** 에 저장됩니다.

## 기능
- **홈**: 책을 그리드로 표시, `＋ 책 추가` 타일
- **추가**: 제목·저자를 입력하면 홈에 카드로 표시
- **상세(4탭)**: 목차 / 내용 / 내용요약 / 메모 — 모두 수기 입력, 자동 저장
  - **내용** 탭은 그림·그래프(이미지) 추가 가능(업로드 시 자동 축소)

## 구조
```
index.html
assets/app.js     그리드·상세·탭·저장·이미지
assets/app.css    민트 테마
assets/icon.svg   아이콘(민트 배경 + 흰 책 + '도서모음')
manifest.webmanifest
sw.js             오프라인 캐시
```

## 동기화 (여러 기기)
- 백엔드: **Cloudflare Worker + KV** (`api/`), 단일 키 `doso-data`에 전체 JSON 저장.
- 엔드포인트: `GET /api/data`(읽기, 누구나) · `PUT /api/data`(쓰기, `X-Edit-Token` 필요).
- 앱 우상단 **🔒/🔓** 로 동기화 비밀번호 입력 → 편집 내용이 서버에 저장되고 다른 기기에서도 보임.
- 비밀번호 없이도 읽기(로컬 전용)는 동작.

### 서버 준비(최초 1회)
```
cd api
npx wrangler kv namespace create BOOKS   # id 를 wrangler.toml 에 반영
npx wrangler deploy
npx wrangler secret put EDIT_TOKEN        # 동기화 비밀번호 설정(대화형)
```

## 참고
- 저장은 서버(KV) + 기기 localStorage 캐시. 그림을 많이 넣으면 용량이 커질 수 있어요(업로드 시 자동 축소).
- 동시 편집은 마지막 저장이 우선(last-write-wins)입니다.
