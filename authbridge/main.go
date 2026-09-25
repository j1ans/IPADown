package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/majd/ipatool/v2/pkg/appstore"
	"github.com/majd/ipatool/v2/pkg/util/operatingsystem"
)

type input struct {
	AppleID  string `json:"appleId"`
	Password string `json:"password"`
	Code     string `json:"code"`
	GUID     string `json:"guid"`
	Cookies  string `json:"cookies"`
}

type output struct {
	OK            bool   `json:"ok"`
	Need2FA       bool   `json:"need2FA,omitempty"`
	Error         string `json:"error,omitempty"`
	AppleID       string `json:"appleId,omitempty"`
	DSID          string `json:"dsPersonId,omitempty"`
	PasswordToken string `json:"passwordToken,omitempty"`
	Storefront    string `json:"storefront,omitempty"`
	Name          string `json:"name,omitempty"`
	Pod           string `json:"pod,omitempty"`
	Cookies       string `json:"cookies,omitempty"`
}

type memoryKeychain struct{ values map[string][]byte }

func (k *memoryKeychain) Get(key string) ([]byte, error) {
	v, ok := k.values[key]
	if !ok { return nil, errors.New("not found") }
	return v, nil
}
func (k *memoryKeychain) Set(key string, value []byte) error { k.values[key] = append([]byte(nil), value...); return nil }
func (k *memoryKeychain) Remove(key string) error { delete(k.values, key); return nil }

type sessionJar struct{ values map[string]string }
func (j *sessionJar) Cookies(_ *url.URL) []*http.Cookie {
	cookies := make([]*http.Cookie, 0, len(j.values))
	for name, value := range j.values { cookies = append(cookies, &http.Cookie{Name: name, Value: value}) }
	return cookies
}
func (j *sessionJar) SetCookies(_ *url.URL, cookies []*http.Cookie) {
	for _, cookie := range cookies {
		if cookie.MaxAge < 0 { delete(j.values, cookie.Name) } else { j.values[cookie.Name] = cookie.Value }
	}
}
func (j *sessionJar) Save() error { return nil }
func (j *sessionJar) importHeader(header string) {
	for _, part := range strings.Split(header, ";") {
		name, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok && name != "" { j.values[name] = value }
	}
}
func (j *sessionJar) header() string {
	parts := make([]string, 0, len(j.values))
	for name, value := range j.values { parts = append(parts, name+"="+value) }
	return strings.Join(parts, "; ")
}

type fixedMachine struct{ guid string }
func (m fixedMachine) MacAddress() (string, error) {
	bytes, err := hex.DecodeString(m.guid)
	if err != nil || len(bytes) != 6 { return "", errors.New("invalid machine GUID") }
	return net.HardwareAddr(bytes).String(), nil
}
func (fixedMachine) HomeDirectory() string { dir, _ := os.UserHomeDir(); return dir }
func (fixedMachine) ReadPassword(int) ([]byte, error) { return nil, errors.New("interactive input disabled") }

func login(in input) output {
	jar := &sessionJar{values: make(map[string]string)}
	jar.importHeader(in.Cookies)
	store := appstore.NewAppStore(appstore.Args{
		Keychain: &memoryKeychain{values: make(map[string][]byte)},
		CookieJar: jar,
		Machine: fixedMachine{guid: in.GUID},
		OperatingSystem: operatingsystem.New(),
	})
	result, err := store.Login(appstore.LoginInput{Email: in.AppleID, Password: in.Password, AuthCode: in.Code})
	if err != nil {
		return output{Need2FA: errors.Is(err, appstore.ErrAuthCodeRequired), Error: err.Error(), Cookies: jar.header()}
	}
	account := result.Account
	return output{OK: true, AppleID: account.Email, DSID: account.DirectoryServicesID,
		PasswordToken: account.PasswordToken, Storefront: account.StoreFront,
		Name: account.Name, Pod: account.Pod, Cookies: jar.header()}
}

func main() {
	var in input
	if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
		fmt.Fprintln(os.Stderr, "invalid authentication request")
		os.Exit(1)
	}
	if in.AppleID == "" || in.Password == "" {
		fmt.Fprintln(os.Stderr, "Apple ID and password are required")
		os.Exit(1)
	}
	json.NewEncoder(os.Stdout).Encode(login(in))
}
